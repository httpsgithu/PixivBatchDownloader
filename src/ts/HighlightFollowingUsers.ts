import { API } from './API'
import { EVT } from './EVT'
import { pageType } from './PageType'
import { store } from './store/Store'
import { Utils } from './utils/Utils'

export interface Following {
  /** 指示这个对象属于哪个用户 id **/
  user: string
  /** 此用户的关注用户的 id 列表 **/
  following: string[]
  /** 此用户公开关注的用户数量。注意，这个数量是 API 返回的 total，实际用户数量可能少于这个值 **/
  publicTotal: number
  /** 此用户私密关注的用户数量。注意，这个数量是 API 返回的 total，实际用户数量可能少于这个值 **/
  privateTotal: number
  /** 最后一次更新数据的时间戳 **/
  time: number
}

export type List = Following[]

class HighlightFollowingUsers {
  constructor() {
    if (!Utils.isPixiv()) {
      return
    }

    // this.loadData()

    this.regularlyCheckUpdate()

    window.setTimeout(() => {
      this.startMutationObserver()
    }, 0)

    chrome.runtime.onMessage.addListener(async (msg) => {
      if (msg.msg === 'dispathFollowingData') {
        console.log('接收到派发的数据', msg.data)
        this.update(msg.data)
      }

      if (msg.msg === 'getFollowingData') {
        const IDList = await this.getList()

        chrome.runtime.sendMessage({
          msg: 'setFollowingData',
          data: {
            action: 'set',
            user: store.loggedUserID,
            IDList: IDList,
            privateTotal: this.privateTotal,
            publicTotal: this.publicTotal
          }
        })
      }
    })

    chrome.runtime.sendMessage({
      msg: 'requestFollowingData'
    })

    // 当用户改变页面主题时，页面元素会重新生成，但是目前的代码不能监听到这个变化
    // 所以借助自定义事件来更新高亮状态
    window.addEventListener(EVT.list.pageThemeChange, () => {
      window.setTimeout(() => {
        this.makeHighlight()
      }, 0)
    })

  }

  private async update(data: List) {
    console.log(data)
    this.list = data
    const index = this.list.findIndex(
      (following) => following.user === store.loggedUserID
    )
    if (index > -1) {
      this.privateTotal = this.list[index].privateTotal
      this.publicTotal = this.list[index].publicTotal
      this.following = this.list[index].following

      // 已经有数据了，执行高亮
      // 在新版页面里，如果此时页面内容还未生成，执行是没有效果的
      // 在旧版页面里（页面内容一次性加载），此时执行是有效的，并且是必须的
      this.makeHighlight()
    } else {
      // 恢复的数据里没有当前用户的数据，需要获取
      chrome.runtime.sendMessage({
        msg: 'needUpdateFollowingData',
        user: store.loggedUserID,
      })
    }
  }

  private list: List = []

  /**当前登录用户的关注用户列表 */
  private following: string[] = []

  private publicTotal = 0
  private privateTotal = 0

  private checkUpdateTimer?: number

  private readonly highlightClassName = 'pbdHighlightFollowing'

  /**全量获取当前用户的所有关注列表 */
  private async getList(): Promise<string[]> {
    console.log('全量获取当前用户的所有关注列表')
    if (!store.loggedUserID) {
      throw new Error('store.loggedUserID is empty')
    }

    // 需要获取公开关注和私密关注
    const publicList = await this.getFollowingList('show')
    const privateList = await this.getFollowingList('hide')

    const followingIDList = publicList.concat(privateList)
    return followingIDList
  }

  /**获取公开或私密关注的用户 ID 列表 */
  private async getFollowingList(rest: 'show' | 'hide'): Promise<string[]> {
    const ids: string[] = []
    let offset = 0
    let total = await this.getFollowingTotal(rest)

    if (total === 0) {
      return ids
    }

    // 每次请求 100 个关注用户的数据
    const limit = 100

    while (ids.length < total) {
      const res = await API.getFollowingList(
        store.loggedUserID,
        rest,
        '',
        offset,
        limit
      )
      offset = offset + limit

      for (const users of res.body.users) {
        ids.push(users.userId)
      }

      if (res.body.users.length === 0) {
        // 实际获取到的关注用户数量可能比 total 少，这是正常的
        // 例如 toal 是 3522，实际上获取到的可能是 3483 个，再往后都是空数组了
        break
      }
    }

    return ids
  }

  /**只请求第一页的数据，以获取 total */
  private async getFollowingTotal(rest: 'show' | 'hide') {
    const res = await API.getFollowingList(store.loggedUserID, rest, '', 0, 24)

    if (rest === 'show') {
      this.publicTotal = res.body.total
    } else {
      this.privateTotal = res.body.total
    }

    return res.body.total
  }

  private addFollow(userID: string) {
    chrome.runtime.sendMessage({
      msg: 'setFollowingData',
      data: {
        action: 'add',
        user: store.loggedUserID,
        IDList: [userID],
        privateTotal: this.privateTotal,
        publicTotal: this.publicTotal
      }
    })
  }

  private unfollow(userID: string) {
    chrome.runtime.sendMessage({
      msg: 'setFollowingData',
      data: {
        action: 'remove',
        user: store.loggedUserID,
        IDList: [userID],
        privateTotal: this.privateTotal,
        publicTotal: this.publicTotal
      }
    })
  }

  private getUpdateTime() {
    // 每次检查更新的最低时间间隔是 5 分钟
    // 如果用户打开了多个标签页，它们都会加载关注列表的第一页来检查数量
    // 所以间隔不宜太短
    const base = 300000

    // 产生一个 10 分钟内的随机数
    const random = Math.random() * 600000

    // 通常不需要担心间隔时间太大导致数据更新不及时
    // 因为多个标签页里只要有一个更新了数据，所有页面都会得到更新
    console.log('下次检查更新的间隔', base + random)
    return base + random
  }

  /**定时检查是否需要更新数据 */
  private async regularlyCheckUpdate() {
    window.clearTimeout(this.checkUpdateTimer)
    // 每隔一定时间检查一次关注用户的数量，如果数量发生变化则执行全量更新
    this.checkUpdateTimer = window.setTimeout(async () => {
      this.checkNeedUpdate()
      return this.regularlyCheckUpdate()
    }, this.getUpdateTime())
  }

  private async checkNeedUpdate() {
    const cfg = [
      {
        old: this.publicTotal,
        rest: 'show',
      },
      {
        old: this.privateTotal,
        rest: 'hide',
      },
    ]

    for (const { old, rest } of cfg) {
      const newTotal = await this.getFollowingTotal(rest as 'show' | 'hide')
      if (old !== newTotal) {
        console.log(`${rest} 数量变化 ${old} -> ${newTotal}`)

        // 有一个可以优化的地方：
        // 现在是一旦检查到公开或私密关注中的任意一个有变化，就全部更新（两者）
        // 可以改为只更新变化的那个
        // 但是这需要设置更多的标记，并且储存数据时也需要把两种关注数据分开存储
        // 考虑到绝大部分情况下，变化的都是公开关注，而且私密关注数量通常都很少
        // 所以一起请求两者,问题也不大,所以我没有做这个优化
        chrome.runtime.sendMessage({
          msg: 'needUpdateFollowingData',
          user: store.loggedUserID,
        })
      }
    }
  }

  // 检查包含用户 id 的链接，并且需要以 id 结束
  // 这是因为 id 之后还有字符的链接是不需要的，例如：
  // https://www.pixiv.net/en/users/17207914/artworks
  // 下载器只匹配用户主页的链接，不匹配用户子页面的链接
  private readonly checkUserLinkReg = /\/users\/(\d+)$/

  private makeHighlight(aList?: HTMLAnchorElement[]) {
    // 这里不需要检查 this.followingList.length === 0 的情况
    // 因为可能之前的数量是 1，之后用户取消关注，变成了 0，那么下面的代码依然需要执行
    // 以把之前高亮过的元素取消高亮

    const allA = aList || document.querySelectorAll('a')
    for (const a of allA) {
      let match = false
      if (a.href) {
        // 小说排行榜里的用户链接普遍带有 /novels 后缀，所以不要求以用户 id 结尾
        const test = a.href.match(
          pageType.type === pageType.list.NovelRanking
            ? /\/users\/(\d+)/
            : this.checkUserLinkReg
        )
        if (test && test.length > 1) {
          match = this.following.includes(test[1])

          // 要高亮的元素
          let target: Element = a

          // 如果用户链接的 a 标签包含子元素，则将 className 添加到它的某个子元素上
          // 这是为了尽量精确的只高亮用户链接，避免高亮区域里包含其他不必要的元素
          // 但是有些页面里不适合这样做，例如在排行榜页面里，a 标签的第一个元素是用户头像
          // 此时如果只高亮第一个元素，那么效果就很不明显，所以就需要高亮整个 a 标签

          // 在多数情况下，高亮第一个子元素
          if (a.firstChild && a.firstChild.nodeType === 1) {
            target = a.firstChild as HTMLElement
          }

          // 在某些页面里高亮最后一个子元素
          if (
            pageType.type === pageType.list.ArtworkRanking ||
            pageType.type === pageType.list.AreaRanking
          ) {
            if (a.lastChild && a.lastChild.nodeType === 1) {
              target = a.lastChild as HTMLElement
            }
          }

          target.classList[match ? 'add' : 'remove'](this.highlightClassName)
        }
      }
    }
  }

  private startMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const addedNodes of mutation.addedNodes) {
            if (addedNodes.nodeName === 'A') {
              this.makeHighlight(Array.from([addedNodes as HTMLAnchorElement]))
            } else {
              // addedNodes 也会包含纯文本，所以判断 nodeType 1，只取 Element
              // https://developer.mozilla.org/zh-CN/docs/Web/API/Node/nodeType
              if (addedNodes.nodeType === 1) {
                const allA = (addedNodes as HTMLElement).querySelectorAll('a')
                this.makeHighlight(Array.from(allA))
              }
            }
          }
        }
      }
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })
  }
}

new HighlightFollowingUsers()