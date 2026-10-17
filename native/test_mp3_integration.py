"""Offline HTTP fixture exercises yt-dlp download, FFmpeg conversion and progress."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import struct
import subprocess
import threading
import time
import unittest
from unittest.mock import patch
import host


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class ConcurrentHLSHandler(QuietHandler):
    active = 0
    peak = 0
    lock = threading.Lock()

    def do_GET(self):
        segment = self.path.endswith('.ts')
        if segment:
            with self.lock:
                type(self).active += 1
                type(self).peak = max(type(self).peak, type(self).active)
            time.sleep(0.1)
        try:
            super().do_GET()
        finally:
            if segment:
                with self.lock:
                    type(self).active -= 1


class MP3IntegrationTest(unittest.TestCase):
    def test_parallel_hls_download_produces_playable_video(self):
        root = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'parallel_hls'
        root.mkdir(parents=True, exist_ok=True)
        playlist = root / 'parallel_video.m3u8'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '5', '-c:a', 'aac', '-hls_time', '0.5', '-hls_playlist_type', 'vod', str(playlist)], check=True)
        ConcurrentHLSHandler.active = ConcurrentHLSHandler.peak = 0
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(ConcurrentHLSHandler, directory=str(root)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        protocol = io.BytesIO()
        try:
            with patch.object(host, 'status', return_value={'success': True, 'folder': str(root / 'output')}), patch.object(host, 'PROTOCOL_OUT', protocol):
                host.download({'url': f'http://127.0.0.1:{server.server_port}/parallel_video.m3u8', 'format': 'video'})
            self.assertGreaterEqual(ConcurrentHLSHandler.peak, 2)
            video = next((root / 'output').glob('*.mp4'))
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(video)], capture_output=True, check=True)
            self.assertGreaterEqual(float(json.loads(probe.stdout)['format']['duration']), 3)
            data = protocol.getvalue()
            frames = []
            while data:
                size = struct.unpack('<I', data[:4])[0]
                frames.append(json.loads(data[4:4 + size]))
                data = data[4 + size:]
            self.assertEqual(frames[-1]['state'], 'complete')
        finally:
            server.shutdown()
            server.server_close()

    def test_real_mp3_download_and_codec(self):
        root = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'
        root.mkdir(parents=True, exist_ok=True)
        sample = root / 'sample.wav'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', str(sample)], check=True)
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(root)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        protocol = io.BytesIO()
        try:
            with patch.object(host, 'status', return_value={'success': True, 'folder': str(root / 'output')}), patch.object(host, 'PROTOCOL_OUT', protocol):
                host.download({'url': f'http://127.0.0.1:{server.server_port}/sample.wav', 'format': 'mp3'})
            mp3 = next((root / 'output').glob('*.mp3'))
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,bit_rate', '-of', 'json', str(mp3)], capture_output=True, check=True)
            stream = json.loads(probe.stdout)['streams'][0]
            self.assertEqual(stream['codec_name'], 'mp3')
            self.assertEqual(int(stream['bit_rate']), 192000)
            frames = []
            data = protocol.getvalue()
            while data:
                size = struct.unpack('<I', data[:4])[0]
                frames.append(json.loads(data[4:4 + size]))
                data = data[4 + size:]
            self.assertEqual(frames[-1]['state'], 'complete')
            self.assertEqual(frames[-1]['percent'], 100)
            self.assertTrue(any(frame.get('stage') == 'MP3 변환' for frame in frames))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
