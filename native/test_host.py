import io
import json
import struct
import unittest
from unittest.mock import patch
import host


class ProtocolTests(unittest.TestCase):
    def test_hls_preference_preserves_resolution_fps_hdr_and_audio(self):
        audio = {'format_id': 'audio-en', 'language': 'en'}
        video = {'format_id': 'http', 'height': 1080, 'fps': 30, 'language': None, 'dynamic_range': 'SDR', 'protocol': 'https'}
        hls = {**video, 'format_id': 'hls', 'protocol': 'm3u8_native', 'vcodec': 'avc1', 'acodec': 'none'}
        selected = {'requested_formats': [video, audio], 'format_id': 'http+audio-en'}
        def fallback(context):
            if any(fmt['format_id'] == 'http' for fmt in context['formats']):
                yield selected
            else:
                yield {'requested_formats': [context['formats'][0], context['formats'][1]], 'format_id': 'hls+audio-en'}
        context = {'formats': [video, hls, audio]}
        result = next(host.prefer_parallel_hls(context, fallback))
        self.assertEqual(result['format_id'], 'hls+audio-en')
        self.assertEqual(result['requested_formats'][1], audio)
        for changed in ({'height': 720}, {'fps': 15}, {'dynamic_range': 'HDR'}):
            context['formats'] = [video, {**hls, **changed}, audio]
            self.assertEqual(next(host.prefer_parallel_hls(context, fallback)), selected)

    def test_unicode_frame(self):
        output = io.BytesIO()
        with patch.object(host, 'PROTOCOL_OUT', output):
            host.send({'title': '영상'})
        data = output.getvalue()
        self.assertEqual(struct.unpack('<I', data[:4])[0], len(data[4:]))
        self.assertEqual(json.loads(data[4:])['title'], '영상')

    def test_reject_non_web_url_and_invalid_quality(self):
        for message in ({'url': 'file:///C:/secret'}, {'url': 'https://example.com', 'quality': 'bad'}):
            with self.assertRaises(ValueError):
                host.download(message)

    def test_stdout_redirect_preserves_protocol(self):
        output = io.BytesIO()
        with patch.object(host, 'PROTOCOL_OUT', output):
            with host.contextlib.redirect_stdout(io.StringIO()):
                host.send({'state': 'complete'})
        self.assertEqual(json.loads(output.getvalue()[4:])['state'], 'complete')


if __name__ == '__main__':
    unittest.main()
