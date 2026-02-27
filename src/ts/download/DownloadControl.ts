import browser from 'webextension-polyfill'
import { EVT } from '../EVT'
import { Tools } from '../Tools'
import {
  downloadArgument,
  DonwloadSuccessData,
  DonwloadSkipData,
  DownloadedMsg,
  TaskList,
} from './DownloadType'
import { store } from '../store/Store'
import { log } from '../Log'
import { lang } from '../Language'
import { Colors } from '../Colors'
import { setSetting, settings } from '../setting/Settings'
import { Download } from '../download/Download'
import { progressBar } from './ProgressBar'
import { downloadStates } from './DownloadStates'
import { ShowDownloadStates } from './ShowDownloadStates'
import { ShowSkipCount } from './ShowSkipCount'
import './ShowDuplicateLog'
import { ShowConvertCount } from './ShowConvertCount'
import { BookmarkAfterDL } from './BookmarkAfterDL'
import { states } from '../store/States'
import { Config } from '../Config'
import { toast } from '../Toast'
import { Utils } from '../utils/Utils'
import { pageType } from '../PageType'
import { msgBox } from '../MsgBox'
import './CheckWarningMessage'

class DownloadControl {
  constructor() {
    this.createResultBtns()

    this.createDownloadArea()

    this.bindEvents()

    const statusTipWrap = this.wrapper.querySelector(
      '.down_status'
    ) as HTMLSpanElement
    new ShowDownloadStates(statusTipWrap)

    const skipTipWrap = this.wrapper.querySelector(
      '.skip_tip'
    ) as HTMLSpanElement
    new ShowSkipCount(skipTipWrap)

    const convertTipWrap = this.wrapper.querySelector(
      '.convert_tip'
    ) as HTMLSpanElement
    new ShowConvertCount(convertTipWrap)

    // 只在 p 站内启用下载后收藏的功能
    if (Utils.isPixiv()) {
      const bmkAfterDLTipWrap = this.wrapper.querySelector(
        '.bmkAfterDL_tip'
      ) as HTMLSpanElement
      new BookmarkAfterDL(bmkAfterDLTipWrap)
    }
  }

  private wrapper: HTMLDivElement = document.createElement('div')

  /**在插槽里添加的操作抓取结果的按钮 */
  private resultBtns: {
    exportCSV: HTMLButtonElement
    exportJSON: HTMLButtonElement
    importJSON: HTMLButtonElement
  } = {
    exportCSV: document.createElement('button'),
    exportJSON: document.createElement('button'),
    importJSON: document.createElement('button'),
  }

  private thread = 5 // 同时下载的线程数的默认值
  // 这里默认设置为 5，是因为国内一些用户的下载速度比较慢，所以不应该同时下载很多文件。
  // 最大值由 Config.downloadThreadMax 定义

  private taskBatch = 0 // 标记任务批次，每次重新下载时改变它的值，传递给后台使其知道这是一次新的下载

  private taskList: TaskList = {} // 下载任务列表，使用下载的文件的 id 做 key，保存下载栏编号和它在下载状态列表中的索引

  private errorIdList: string[] = [] // 有任务下载失败时，保存 id

  private downloaded = 0 // 已下载的任务数量

  private stop = false // 是否已经停止下载

  private pause = false // 是否已经暂停下载

  private crawlIdListTimer: undefined | number = undefined

  private checkDownloadTimeoutTimer: undefined | number = undefined

  private readonly msgFlag = 'uuidTip'

  // 类型守卫
  private isDownloadedMsg(msg: any): msg is DownloadedMsg {
    return !!msg.msg
  }

  private bindEvents() {
    window.addEventListener(EVT.list.crawlStart, () => {
      this.hideResultBtns()
      this.hideDownloadArea()
      this.reset()
    })

    for (const ev of [
      EVT.list.crawlComplete,
      EVT.list.resultChange,
      EVT.list.resume,
    ]) {
      window.addEventListener(ev, (ev) => {
        // 当恢复了未完成的抓取数据时，将下载状态设置为暂停
        this.pause = ev.type === 'resume'
        // 让开始下载的方法进入任务队列，以便让监听上述事件的其他部分的代码先执行完毕
        window.setTimeout(() => {
          this.readyDownload()
        }, 0)
      })
    }

    window.addEventListener(EVT.list.skipDownload, (ev: CustomEventInit) => {
      // 跳过下载的文件不会触发 downloadSuccess 事件
      const data = ev.detail.data as DonwloadSkipData
      this.downloadOrSkipAFile(data)
    })

    window.addEventListener(EVT.list.downloadError, (ev: CustomEventInit) => {
      const id = ev.detail.data as string
      this.downloadError(id)
    })

    window.addEventListener(EVT.list.requestPauseDownload, (ev) => {
      // 请求暂停下载
      this.pauseDownload()
    })

    // 如果下载器让浏览器保存文件到本地，但是之后没有收到回应（不知道文件是否有成功保存），这会导致下载进度卡住
    window.addEventListener(EVT.list.sendBrowserDownload, () => {
      window.clearTimeout(this.checkDownloadTimeoutTimer)
      this.checkDownloadTimeoutTimer = window.setTimeout(() => {
        const msg =
          lang.transl('_可能发生了错误请刷新页面重试') +
          '<br>' +
          lang.transl('_下载卡住的提示')
        log.warning(msg, 1, false, 'mayError')
      }, 30000)
    })

    const clearDownloadTimeoutTimerList = [
      EVT.list.downloadComplete,
      EVT.list.downloadError,
      EVT.list.downloadPause,
      EVT.list.downloadStop,
      EVT.list.downloadSuccess,
      EVT.list.crawlStart,
    ]
    clearDownloadTimeoutTimerList.forEach((evt) => {
      window.addEventListener(evt, () => {
        window.clearTimeout(this.checkDownloadTimeoutTimer)
      })
    })

    // 监听浏览器返回的消息
    browser.runtime.onMessage.addListener((msg: any) => {
      if (!this.taskBatch) {
        return
      }

      if (!this.isDownloadedMsg(msg)) {
        return
      }

      // UUID 的情况
      if (msg.data?.uuid) {
        log.log(lang.transl('_uuid'), 1, false, 'filenameUUID')
        msgBox.once(this.msgFlag, lang.transl('_uuid'), 'show')
        this.pauseDownload()
      }

      // 文件下载成功
      if (msg.msg === 'downloaded') {
        URL.revokeObjectURL(msg.data.blobURLFront)

        // 发送下载成功的事件
        EVT.fire('downloadSuccess', msg.data)

        this.downloadOrSkipAFile(msg.data)
      } else if (msg.msg === 'download_err') {
        // 浏览器把文件保存到本地失败

        // 用户操作导致下载取消的情况，跳过这个文件，不再重试保存它。触发条件如：
        // 用户在浏览器弹出“另存为”对话框时取消保存
        // 用户让 IDM 转接这个下载时
        if (msg.err === 'USER_CANCELED') {
          log.error(
            lang.transl(
              '_user_canceled_tip',
              Tools.createWorkLink(msg.data.id),
              msg.err || 'unknown'
            )
          )

          this.downloadOrSkipAFile(msg.data)
          return
        }

        // 其他原因，下载器会重试保存这个文件
        log.error(
          lang.transl(
            '_save_file_failed_tip',
            Tools.createWorkLink(msg.data.id),
            msg.err || 'unknown'
          )
        )

        if (msg.err === 'FILE_FAILED') {
          log.error(lang.transl('_FILE_FAILED_tip'))
        }

        EVT.fire('saveFileError')
        // 重新下载这个文件
        // 但并不确定能否如预期一样重新下载这个文件
        this.saveFileError(msg.data)
      }
    })

    // 当下载完毕，或者抓取结果为空时，检查是否有等待下载的任务
    const checkWaitingIdListEvents = [
      EVT.list.downloadComplete,
      EVT.list.crawlEmpty,
    ]
    checkWaitingIdListEvents.forEach((evt) => {
      window.addEventListener(evt, () => {
        // 如果有等待中的下载任务，则开始下载等待中的任务
        if (store.waitingIdList.length === 0) {
          toast.success(lang.transl('_下载完毕2'), {
            position: 'center',
          })

          // 通知后台清除保存的此标签页的 idList
          browser.runtime.sendMessage({
            msg: 'clearDownloadsTempData',
          })
        } else {
          // 下载等待中的任务
          window.clearTimeout(this.crawlIdListTimer)
          this.crawlIdListTimer = window.setTimeout(() => {
            const idList = [...store.waitingIdList]
            store.waitingIdList = []
            EVT.fire('crawlIdList', idList)
          }, 0)
        }
      })
    })
  }

  private createDownloadArea() {
    const html = `<div class="download_area">
    <div class="centerWrap_btns">
      <slot data-name="downloadControlBtns"></slot>
    </div>
    <div class="download_status_text_wrap">
      <span data-xztext="_当前状态"></span>
      <span class="down_status" data-xztext="_未开始下载"></span>
      <span class="skip_tip warn"></span>
      <span class="convert_tip warn"></span>
      <span class="bmkAfterDL_tip green"></span>
    </div>
    </div>`

    this.wrapper = Tools.useSlot('downloadArea', html) as HTMLDivElement
    lang.register(this.wrapper)

    // 添加按钮
    Tools.addBtn(
      'downloadControlBtns',
      Colors.bgBlue,
      '_开始下载',
      '',
      'startDownload'
    ).addEventListener('click', () => {
      this.startDownload()
    })

    Tools.addBtn(
      'downloadControlBtns',
      Colors.bgYellow,
      '_暂停下载',
      '',
      'pauseDownload'
    ).addEventListener('click', () => {
      this.pauseDownload()
    })

    Tools.addBtn(
      'downloadControlBtns',
      Colors.bgRed,
      '_停止下载',
      '',
      'stopDownload'
    ).addEventListener('click', () => {
      this.stopDownload()
    })

    Tools.addBtn(
      'downloadControlBtns',
      Colors.bgGreen,
      '_复制url',
      '',
      'copyURLs'
    ).addEventListener('click', () => {
      EVT.fire('showURLs')
    })
  }

  private createResultBtns() {
    // 只在 pixiv 上添加这些按钮
    if (Utils.isPixiv()) {
      // 导入抓取结果
      this.resultBtns.importJSON = Tools.addBtn(
        'exportResult',
        Colors.bgGreen,
        '_导入抓取结果',
        '',
        'importCrawlResults'
      )
      // 导入抓取结果的按钮始终显示，因为它需要始终可用。
      // 导出抓取结果的按钮只有在可以准备下载时才显示

      this.resultBtns.importJSON.addEventListener(
        'click',
        () => {
          EVT.fire('importResult')
        },
        false
      )

      // 导出抓取结果
      this.resultBtns.exportJSON = Tools.addBtn(
        'exportResult',
        Colors.bgGreen,
        '_导出抓取结果',
        '',
        'exportCrawlResultsJSON'
      )
      this.resultBtns.exportJSON.style.display = 'none'

      this.resultBtns.exportJSON.addEventListener(
        'click',
        () => {
          EVT.fire('exportResult')
        },
        false
      )

      // 导出 csv
      this.resultBtns.exportCSV = Tools.addBtn(
        'exportResult',
        Colors.bgGreen,
        '_导出csv',
        '',
        'exportCrawlResultsCSV'
      )
      this.resultBtns.exportCSV.style.display = 'none'

      this.resultBtns.exportCSV.addEventListener(
        'click',
        () => {
          EVT.fire('exportCSV')
        },
        false
      )
    }
  }

  // 抓取完毕之后，已经可以开始下载时，显示必要的信息，并决定是否立即开始下载
  private readyDownload() {
    if (states.busy) {
      return
    }
    if (store.result.length === 0) {
      return progressBar.reset(0)
    }

    if (settings.downloadUgoiraFirst) {
      store.resultMeta.sort(Tools.sortUgoiraFirst)
      store.result.sort(Tools.sortUgoiraFirst)
    }

    EVT.fire('readyDownload')

    this.showResultBtns()

    this.showDownloadArea()

    this.setDownloaded()

    this.setDownloadThread()

    // 在插画漫画搜索页面里，如果启用了“预览搜索页面的筛选结果”
    if (
      pageType.type === pageType.list.ArtworkSearch &&
      settings.previewResult
    ) {
      // “预览搜索页面的筛选结果”会阻止自动开始下载。但是一些情况例外
      // 允许快速抓取发起的下载请求自动开始下载
      // 允许由抓取标签列表功能发起的下载请求自动开始下载
      if (!states.quickCrawl && !states.crawlTagList) {
        return
      }
    }

    // 自动开始下载的情况
    if (
      settings.autoStartDownload ||
      states.quickCrawl ||
      states.crawlTagList
    ) {
      this.startDownload()
    }
  }

  // 开始下载
  private startDownload() {
    if (states.busy) {
      return toast.error(lang.transl('_当前任务尚未完成'))
    }

    if (store.result.length === 0) {
      return toast.error(lang.transl('_没有可用的抓取结果'))
    }

    if (this.pause) {
      // 从上次中断的位置继续下载
      // 把“使用中”的下载状态重置为“未使用”
      downloadStates.resume()
    } else {
      // 如果之前没有暂停任务，也没有进入恢复模式，则重新下载
      // 初始化下载状态列表
      downloadStates.init()
    }

    this.reset()

    msgBox.resetOnce(this.msgFlag)

    this.setDownloaded()

    this.taskBatch = new Date().getTime() // 修改本批下载任务的标记

    this.setDownloadThread()

    EVT.fire('downloadStart')

    // 建立并发下载线程
    for (let i = 0; i < this.thread; i++) {
      window.setTimeout(() => {
        this.createDownload(i)
      }, 0)
    }

    toast.show(lang.transl('_开始下载'))
    // 这条日志前面不添加 emoji
    log.success(lang.transl('_正在下载中'))

    if (Config.mobile) {
      log.warning(lang.transl('_移动端浏览器可能不会建立文件夹的说明'))
    }
  }

  // 暂停下载
  private pauseDownload() {
    if (store.result.length === 0) {
      return
    }

    // 停止的优先级高于暂停。点击停止可以取消暂停状态，但点击暂停不能取消停止状态
    if (this.stop === true) {
      return
    }

    if (this.pause === false) {
      // 如果正在下载中
      if (states.busy) {
        this.pause = true
        log.warning('⏸️' + lang.transl('_已暂停'), 2)

        EVT.fire('downloadPause')
      } else {
        // 不在下载中的话不允许启用暂停功能
        return
      }
    }
  }

  // 停止下载
  private stopDownload() {
    if (store.result.length === 0 || this.stop) {
      return
    }

    this.stop = true
    log.error('🛑' + lang.transl('_已停止'), 2)
    this.pause = false

    EVT.fire('downloadStop')
  }

  private downloadError(id: string) {
    this.errorIdList.push(id)

    // 是否继续下载
    const task = this.taskList[id]
    const no = task.progressBarIndex
    if (this.checkContinueDownload()) {
      this.createDownload(no)
    } else {
      this.checkCompleteWithError()
    }
  }

  private setDownloaded() {
    this.downloaded = downloadStates.downloadedCount()

    // 显示下载进度
    const text = `${this.downloaded} / ${store.result.length}`
    log.log('➡️' + text, 1, false, 'downloadProgress')

    // 设置总下载进度条
    progressBar.setTotalProgress(this.downloaded)

    store.remainingDownload = store.result.length - this.downloaded

    // 所有文件正常下载完毕（跳过下载的文件也算正常下载）
    if (this.downloaded === store.result.length) {
      log.success('✅' + lang.transl('_下载完毕'), 2)
      window.setTimeout(() => {
        // 延后触发下载完成的事件。因为下载完成事件是由上游事件（跳过下载，或下载成功事件）派生的，如果这里不延迟触发，可能导致其他模块先接收到下载完成事件，后接收到上游事件。
        EVT.fire('downloadComplete')
      }, 0)
      this.reset()
    }

    this.checkCompleteWithError()
  }

  // 设置下载线程数量
  private setDownloadThread() {
    const setThread = settings.downloadThread
    if (
      setThread < 1 ||
      setThread > Config.downloadThreadMax ||
      isNaN(setThread)
    ) {
      // 如果数值非法，则重设为默认值
      this.thread = Config.downloadThreadMax
      setSetting('downloadThread', Config.downloadThreadMax)
    } else {
      this.thread = setThread // 设置为用户输入的值
    }

    // 如果剩余任务数量少于下载线程数
    if (store.result.length - this.downloaded < this.thread) {
      this.thread = store.result.length - this.downloaded
    }

    // 重设下载进度条
    progressBar.reset(this.thread, this.downloaded)
  }

  private saveFileError(data: DonwloadSuccessData) {
    if (this.pause || this.stop) {
      return false
    }
    const task = this.taskList[data.id]
    // 复位这个任务的状态
    downloadStates.setState(task.index, -1)
    // 建立下载任务，再次下载它
    this.createDownload(task.progressBarIndex)
  }

  private downloadOrSkipAFile(data: DonwloadSuccessData | DonwloadSkipData) {
    const task = this.taskList[data.id]

    // 更改这个任务状态为“已完成”
    downloadStates.setState(task.index, 1)

    // 统计已下载数量
    this.setDownloaded()

    // 是否继续下载
    const no = task.progressBarIndex
    if (this.checkContinueDownload()) {
      this.createDownload(no)
    }
  }

  // 当一个文件下载成功或失败之后，检查是否还有后续下载任务
  private checkContinueDownload() {
    // 如果没有全部下载完毕
    if (this.downloaded < store.result.length) {
      // 如果任务已停止
      if (this.pause || this.stop) {
        return false
      }
      // 如果已完成的数量 加上 线程中未完成的数量，仍然没有达到文件总数，继续添加任务
      if (this.downloaded + this.thread - 1 < store.result.length) {
        return true
      } else {
        return false
      }
    } else {
      return false
    }
  }

  // 查找需要进行下载的作品，建立下载
  private createDownload(progressBarIndex: number) {
    const index = downloadStates.getFirstDownloadItem()
    if (index === undefined) {
      // 当已经没有需要下载的作品时，检查是否带着错误完成了下载
      // 如果下载过程中没有出错，就不会执行到这个分支
      return this.checkCompleteWithError()
    } else {
      const workData = store.result[index]
      const argument: downloadArgument = {
        id: workData.id,
        result: workData,
        index: index,
        progressBarIndex: progressBarIndex,
        taskBatch: this.taskBatch,
      }

      // 保存任务信息
      this.taskList[workData.id] = {
        index,
        progressBarIndex: progressBarIndex,
      }

      // 建立下载
      new Download(progressBarIndex, argument, index)
    }
  }

  // 在有下载出错的情况下，是否已经完成了下载
  private checkCompleteWithError() {
    if (
      this.errorIdList.length > 0 &&
      this.downloaded + this.errorIdList.length === store.result.length
    ) {
      // 进入暂停状态，一定时间后自动开始下载，重试下载出错的文件
      this.pauseDownload()
      setTimeout(() => {
        this.startDownload()
      }, 2000)
    }
  }

  private reset() {
    this.pause = false
    this.stop = false
    this.errorIdList = []
    this.downloaded = 0
  }

  private showDownloadArea() {
    this.wrapper.style.display = 'block'
  }

  private hideDownloadArea() {
    this.wrapper.style.display = 'none'
  }

  private showResultBtns() {
    this.resultBtns.exportJSON.style.display = 'flex'
    this.resultBtns.exportCSV.style.display = 'flex'
  }

  private hideResultBtns() {
    this.resultBtns.exportJSON.style.display = 'none'
    this.resultBtns.exportCSV.style.display = 'none'
  }
}

new DownloadControl()
