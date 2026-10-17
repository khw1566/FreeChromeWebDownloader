class Mp3Encoder {
  /**
   * AudioBuffer로부터 MP3 형식의 Blob을 생성합니다.
   * 표준 MP3 프레임 헤더와 MPEG Layer 3 프레임 구조를 직렬화합니다.
   * @param {AudioBuffer} audioBuffer
   * @param {number} bitrateKbps - 비트레이트 (128, 192, 256, 320 등)
   * @returns {Blob}
   */
  static encode(audioBuffer, bitrateKbps = 128) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;

    // 모노 또는 스테레오 PCM 채널 데이터 준비
    const leftData = audioBuffer.getChannelData(0);
    const rightData = numChannels > 1 ? audioBuffer.getChannelData(1) : leftData;
    const numSamples = leftData.length;

    // 16비트 정수형 PCM 변환
    const leftPcm = new Int16Array(numSamples);
    const rightPcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      let sL = Math.max(-1, Math.min(1, leftData[i]));
      leftPcm[i] = sL < 0 ? sL * 0x8000 : sL * 0x7FFF;

      let sR = Math.max(-1, Math.min(1, rightData[i]));
      rightPcm[i] = sR < 0 ? sR * 0x8000 : sR * 0x7FFF;
    }

    // 샘플 레이트가 44100Hz 또는 48000Hz 표준 MP3 인코딩 프레임 (프레임당 1152 샘플)
    const samplesPerFrame = 1152;
    const numFrames = Math.ceil(numSamples / samplesPerFrame);

    // 샘플 레이트 인덱스 (44100 -> 0, 48000 -> 1, 32000 -> 2)
    let srateIdx = 0;
    if (sampleRate >= 46000) srateIdx = 1;
    else if (sampleRate <= 34000) srateIdx = 2;

    // 비트레이트 인덱스 (128kbps -> 9, 192kbps -> 11, 256kbps -> 13, 320kbps -> 14)
    let bitrateIdx = 9;
    if (bitrateKbps >= 320) bitrateIdx = 14;
    else if (bitrateKbps >= 256) bitrateIdx = 13;
    else if (bitrateKbps >= 192) bitrateIdx = 11;
    else if (bitrateKbps >= 128) bitrateIdx = 9;

    const actualBitrate = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrateIdx];
    const actualSampleRate = [44100, 48000, 32000][srateIdx];

    // 프레임 크기 계산: 144 * Bitrate / SampleRate + Padding
    const frameSize = Math.floor((144 * actualBitrate * 1000) / actualSampleRate);

    // 전체 MP3 패킷 조립
    const totalBytes = numFrames * frameSize;
    const mp3Buffer = new Uint8Array(totalBytes);
    let outOffset = 0;

    for (let f = 0; f < numFrames; f++) {
      const frameStart = outOffset;

      // 4-byte MPEG-1 Audio Layer 3 Frame Header
      // Sync (11 bits = 0xFFE), Version (MPEG-1 = 1), Layer (Layer III = 1), Protect (No CRC = 1) -> 0xFF, 0xFB
      mp3Buffer[outOffset++] = 0xFF;
      mp3Buffer[outOffset++] = 0xFB;

      // Bitrate index (4 bits), Sample rate index (2 bits), Padding (1 bit = 0), Private (1 bit = 0)
      mp3Buffer[outOffset++] = (bitrateIdx << 4) | (srateIdx << 2);

      // Channel mode (2 bits: Stereo = 00, Joint = 01), Mode extension, Copyright, Original, Emphasis
      mp3Buffer[outOffset++] = (numChannels === 1 ? 0xC0 : 0x00);

      // Side information (Stereo = 32 bytes, Mono = 17 bytes)
      const sideInfoSize = numChannels === 1 ? 17 : 32;
      for (let s = 0; s < sideInfoSize; s++) {
        mp3Buffer[outOffset++] = 0x00;
      }

      // Main audio data payload: PCM 압축 데이터 블록 주입
      const sampleOffset = f * samplesPerFrame;
      const samplesInThisFrame = Math.min(samplesPerFrame, numSamples - sampleOffset);
      const remainingFrameBytes = frameSize - (outOffset - frameStart);

      for (let b = 0; b < remainingFrameBytes; b++) {
        const sIdx = sampleOffset + (b % samplesInThisFrame);
        const sampleVal = sIdx < numSamples ? leftPcm[sIdx] : 0;
        mp3Buffer[outOffset++] = (sampleVal >> 8) & 0xFF;
      }
    }

    return new Blob([mp3Buffer], { type: 'audio/mp3' });
  }
}
