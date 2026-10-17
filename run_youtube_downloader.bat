@echo off
title YouTube Downloader Demo Script
echo ============================================
echo YouTube Downloader Demo Script
echo ============================================
echo.
set /p YOUTUBE_URL="Enter YouTube Video URL: "
echo.
echo Analyzing YouTube URL...
"C:\Users\khw\AppData\Local\Programs\Python\Python312\python.exe" "C:\Users\khw\Desktop\미디어다운로드 확장프로그램\youtube_downloader_demo.py" "%YOUTUBE_URL%"
echo.
echo Process finished.
pause
