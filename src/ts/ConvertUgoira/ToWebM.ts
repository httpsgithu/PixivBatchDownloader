import { EVT } from '../EVT'
import { UgoiraInfo } from '../crawl/CrawlResult'

declare const Mediabunny: any

class ToWebM {
  public async convert(
    ImageBitmapList: ImageBitmap[],
    info: UgoiraInfo
  ): Promise<Blob> {
    const output = new Mediabunny.Output({
      format: new Mediabunny.WebMOutputFormat(),
      target: new Mediabunny.BufferTarget(),
    })

    const videoSource = new Mediabunny.VideoSampleSource({
      codec: 'vp9',
      bitrate: Mediabunny.QUALITY_HIGH,
    })
    output.addVideoTrack(videoSource)

    await output.start()

    let timestamp = 0
    for (let i = 0; i < ImageBitmapList.length; i++) {
      const bitmap = ImageBitmapList[i]
      const duration = info.frames[i].delay / 1000
      const sample = new Mediabunny.VideoSample(bitmap, {
        timestamp: timestamp, // in seconds
        duration: duration, // in seconds
      })
      await videoSource.add(sample)
      sample.close()
      timestamp += duration
    }

    await output.finalize()
    const blob = new Blob([output.target.buffer], { type: 'video/webm' })

    EVT.fire('convertSuccess')
    return blob
  }
}

const toWebM = new ToWebM()
export { toWebM }
