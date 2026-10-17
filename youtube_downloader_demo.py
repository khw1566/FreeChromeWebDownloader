import os
import sys
import json
import urllib.request
import urllib.parse
import re

# Windows 콘솔 출력 UTF-8 인코딩 설정
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

class YouTubeMediaExtractor:
    """
    유튜브 URL을 분석하여 미디어 정보를 파싱하고 다운로드 스트림 URL을 추출하는 클래스
    """
    def __init__(self, url):
        self.url = url
        self.video_id = self._extract_video_id(url)
        self.player_response = None

    def _extract_video_id(self, url):
        pattern = r'(?:v=|\/([0-9A-Za-z_-]{11}).*|g\/|v\/|e\/|u\/\w+\/|embed\/|shorts\/)([^#&?]*)*'
        match = re.search(pattern, url)
        if match and match.group(1):
            return match.group(1)
        elif match and match.group(2) and len(match.group(2)) == 11:
            return match.group(2)
        # 기본 쿼리 파라미터 v 추출
        parsed = urllib.parse.urlparse(url)
        qs = urllib.parse.parse_qs(parsed.query)
        if 'v' in qs:
            return qs['v'][0]
        return "dQw4w9WgXcQ"

    def fetch_metadata(self):
        """
        Innertube API를 모방하여 비디오 메타데이터 및 스트리밍 데이터 요청
        """
        api_url = f"https://www.youtube.com/watch?v={self.video_id}"
        req = urllib.request.Request(
            api_url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8'
            }
        )
        
        try:
            with urllib.request.urlopen(req) as response:
                html = response.read().decode('utf-8')

            # ytInitialPlayerResponse JSON 객체 정규식 파싱
            patterns = [
                r'ytInitialPlayerResponse\s*=\s*({.+?});var',
                r'ytInitialPlayerResponse\s*=\s*({.+?});</script>',
                r'window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});'
            ]
            
            for p in patterns:
                match = re.search(p, html, re.DOTALL)
                if match:
                    self.player_response = json.loads(match.group(1))
                    return self.player_response

            raise Exception("ytInitialPlayerResponse 파싱 패턴 불일치")
        except Exception as e:
            print(f"메타데이터 파싱 실패: {e}")
            return None

    def get_stream_urls(self):
        """
        비디오 및 오디오 포맷 정보 추출
        """
        if not self.player_response:
            self.fetch_metadata()

        if not self.player_response:
            return []

        streaming_data = self.player_response.get('streamingData', {})
        formats = streaming_data.get('formats', [])
        adaptive_formats = streaming_data.get('adaptiveFormats', [])

        all_formats = formats + adaptive_formats
        extracted_streams = []

        for fmt in all_formats:
            mime_type = fmt.get('mimeType', '')
            quality = fmt.get('qualityLabel', fmt.get('audioQuality', 'N/A'))
            content_length = fmt.get('contentLength', '0')
            url = fmt.get('url')

            if not url and 'signatureCipher' in fmt:
                cipher_str = fmt['signatureCipher']
                cipher_params = urllib.parse.parse_qs(cipher_str)
                url = cipher_params.get('url', [None])[0]

            if url:
                extracted_streams.append({
                    'itag': fmt.get('itag'),
                    'mimeType': mime_type,
                    'quality': quality,
                    'contentLength': int(content_length),
                    'url': url
                })

        return extracted_streams


class DownloaderCLI:
    """
    사용자 인터페이스 및 다운로드 시연 클래스
    """
    def __init__(self, target_url):
        self.extractor = YouTubeMediaExtractor(target_url)

    def run(self):
        print("==========================================")
        print("유튜브 미디어 분석 데모 스크립트")
        print("==========================================")
        print(f"분석 URL: {self.extractor.url}")
        print(f"비디오 ID: {self.extractor.video_id}")
        print("\n메타데이터 탐색 중...")

        metadata = self.extractor.fetch_metadata()
        if not metadata:
            print("오류: 비디오 메타데이터 수집에 실패했습니다.")
            return

        video_details = metadata.get('videoDetails', {})
        title = video_details.get('title', 'Unknown')
        author = video_details.get('author', 'Unknown')

        print(f"\n[영상 제목]: {title}")
        print(f"[업로더]: {author}")

        streams = self.extractor.get_stream_urls()
        print(f"\n[추출된 미디어 스트림 ({len(streams)}개)]")
        print("-" * 65)
        
        for idx, stream in enumerate(streams[:8], 1):
            size_mb = round(stream['contentLength'] / (1024 * 1024), 2) if stream['contentLength'] > 0 else "미정"
            mime_short = stream['mimeType'].split(';')[0]
            print(f"{idx}. [{mime_short}] 화질/음질: {stream['quality']} | 예상 크기: {size_mb} MB")
            print(f"   URL: {stream['url'][:75]}...")
            print("-" * 65)

if __name__ == '__main__':
    demo_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    if len(sys.argv) > 1:
        demo_url = sys.argv[1]

    cli = DownloaderCLI(demo_url)
    cli.run()
