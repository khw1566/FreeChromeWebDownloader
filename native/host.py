"""Chrome native messaging host. stdout is reserved for framed JSON."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import threading
import time
from urllib.parse import urlsplit

PROTOCOL_OUT = sys.stdout.buffer
PROTOCOL_LOCK = threading.Lock()

# Use project-local tools without changing the user's global PATH.
TOOLS_DIR = Path(__file__).resolve().parent / 'tools'
FFMPEG_BIN = next(TOOLS_DIR.glob('ffmpeg/**/bin/ffmpeg.exe'), None)
if FFMPEG_BIN:
    os.environ['PATH'] = str(FFMPEG_BIN.parent) + os.pathsep + os.environ.get('PATH', '')
NODE_DIR = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'nodejs'
if (NODE_DIR / 'node.exe').is_file():
    os.environ['PATH'] = str(NODE_DIR) + os.pathsep + os.environ.get('PATH', '')


def send(data):
    payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
    with PROTOCOL_LOCK:
        PROTOCOL_OUT.write(struct.pack('<I', len(payload)) + payload)
        PROTOCOL_OUT.flush()


def read_message():
    header = sys.stdin.buffer.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError('Incomplete message header')
    size = struct.unpack('<I', header)[0]
    if size > 65536:
        raise ValueError('Message too large')
    payload = sys.stdin.buffer.read(size)
    if len(payload) != size:
        raise ValueError('Incomplete message')
    return json.loads(payload)


def status():
    missing = []
    if importlib.util.find_spec('yt_dlp') is None:
        missing.append('yt-dlp[default]')
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            missing.append(tool)
    if not any(shutil.which(tool) for tool in ('deno', 'node')):
        missing.append('Deno 또는 Node.js')
    return {'success': not missing, 'error': '필요한 프로그램: ' + ', '.join(missing) if missing else '',
            'folder': str(Path.home() / 'Downloads' / 'Media Downloader')}


def prefer_parallel_hls(context, fallback):
    """Prefer YouTube HLS only at the selected resolution/FPS; retain audio."""
    for selected in fallback(context):
        tracks = selected.get('requested_formats') or []
        if len(tracks) != 2:
            yield selected
            continue
        video, audio = tracks
        candidates = [fmt for fmt in context['formats']
                      if fmt.get('protocol') == 'm3u8_native'
                      and fmt.get('vcodec') not in (None, 'none')
                      and fmt.get('acodec') == 'none'
                      and video.get('height') is not None
                      and fmt.get('height') == video.get('height')
                      and fmt.get('fps') == video.get('fps')
                      and fmt.get('language') == video.get('language')
                      and fmt.get('dynamic_range') == video.get('dynamic_range')]
        if not candidates or video.get('protocol') == 'm3u8_native':
            yield selected
            continue
        # Let yt-dlp rebuild the merged format/container metadata itself.
        allowed = {candidates[-1]['format_id'], audio['format_id']}
        restricted = {**context, 'formats': [fmt for fmt in context['formats'] if fmt['format_id'] in allowed]}
        replacements = list(fallback(restricted))
        yield replacements[0] if replacements else selected


def download(message):
    url = message.get('url', '')
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Invalid page URL')
    quality = message.get('quality', '1080')
    if quality not in ('best', '1080', '720'):
        raise ValueError('Invalid quality')
    output_format = message.get('format', 'video')
    if output_format not in ('video', 'mp3'):
        raise ValueError('Invalid output format')
    ready = status()
    if not ready['success']:
        raise RuntimeError(ready['error'])
    from yt_dlp import YoutubeDL
    folder = Path(ready['folder'])
    folder.mkdir(parents=True, exist_ok=True)
    send({'success': True, 'state': 'starting', 'stage': '영상 정보 분석', 'percent': None, 'folder': str(folder)})
    last_progress = None
    last_sent = 0
    progress_lock = threading.Lock()

    def progress(data):
        nonlocal last_progress, last_sent
        if data['status'] == 'finished':
            send({'success': True, 'state': 'processing', 'percent': None, 'folder': str(folder)})
        elif data['status'] == 'downloading':
            with progress_lock:
                total = data.get('total_bytes') or data.get('total_bytes_estimate')
                percent = min(99, int(data.get('downloaded_bytes', 0) * 100 / total)) if total else None
                info = data.get('info_dict', {})
                stream = info.get('format_id', '')
                now = time.monotonic()
                # Bound IPC/storage traffic even with parallel fragment workers.
                if stream != last_progress or now - last_sent >= 0.5:
                    last_progress, last_sent = stream, now
                    send({'success': True, 'state': 'downloading', 'percent': percent,
                          'stage': '현재 스트림', 'speed': data.get('speed'), 'eta': data.get('eta'),
                          'downloadedBytes': data.get('downloaded_bytes'), 'totalBytes': total,
                          'height': info.get('height'), 'folder': str(folder)})

    def postprocess(data):
        if data['status'] in ('started', 'processing'):
            send({'success': True, 'state': 'processing', 'percent': None,
                  'stage': 'MP3 변환' if output_format == 'mp3' else '영상·음성 합치기', 'folder': str(folder)})

    # Some generic HLS playlists omit resolution; keep them downloadable.
    cap = '' if quality == 'best' else '[height<=?' + quality + ']'
    options = {
        'format': 'ba/b' if output_format == 'mp3' else 'bv*' + cap + '+ba/b' + cap,
        'outtmpl': str(folder / ('%(title).160B [%(id)s]' + (' - audio' if output_format == 'mp3' else '') + '.%(ext)s')),
        'windowsfilenames': True, 'noplaylist': True, 'quiet': True, 'no_warnings': True, 'noprogress': True,
        'concurrent_fragment_downloads': 4,
        'skip_unavailable_fragments': False,
        # YouTube exposes HTTP streams as range fragments so the native DASH
        # downloader can fetch them concurrently. Do not override chunk size.
        'extractor_args': {'youtube': {'formats': ['dashy']}},
        'progress_hooks': [progress], 'merge_output_format': 'mp4/mkv',
        'postprocessor_hooks': [postprocess],
        'js_runtimes': {name: {} for name in ('deno', 'node') if shutil.which(name)},
    }
    if output_format == 'mp3':
        options['postprocessors'] = [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}]
    # Libraries must never write text into Chrome's protocol stream.
    with contextlib.redirect_stdout(sys.stderr):
        with YoutubeDL(options) as downloader:
            if output_format == 'video' and (parsed.hostname == 'youtu.be' or parsed.hostname == 'youtube.com' or parsed.hostname.endswith('.youtube.com')):
                fallback = downloader.build_format_selector(options['format'])
                downloader.format_selector = lambda context: prefer_parallel_hls(context, fallback)
            result = downloader.download([url])
    if result:
        raise RuntimeError('다운로드에 실패했습니다.')
    send({'success': True, 'state': 'complete', 'percent': 100, 'folder': str(folder)})


def main():
    if os.name == 'nt':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        message = read_message()
        if message is None:
            return
        if message.get('action') == 'status':
            send(status())
        elif message.get('action') == 'download':
            download(message)
        else:
            raise ValueError('Unknown action')
    except Exception as error:
        send({'success': False, 'state': 'error', 'error': str(error)[:2000]})


if __name__ == '__main__':
    main()
