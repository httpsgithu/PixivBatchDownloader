import browser from 'webextension-polyfill'
import {
  DeletedUser,
  FollowingData,
  AllUserFollowingData,
  UserInfo,
} from './FollowingData'
import { deletedFollowingUsers } from './DeletedFollowingUsers'
import { backgroundAPI } from './backgroundAPI'

interface SetData {
  /**数据属于哪个用户 */
  user: string
  /**此用户的关注用户的 id 列表 **/
  following: string[]
  followedUsersInfo: UserInfo[]
  /**此用户的关注用户总数。注意这可能与 following 的 length 不同*/
  total: number
}

type Msg = {
  msg: string
  data?: SetData
}

interface UserOperate {
  action: '' | 'add' | 'remove'
  loggedUserID: string
  userID: string
}

// 这是一个后台脚本
class ManageFollowing {
  constructor() {
    this.restore()

    // 定时检查 deletedUsers 是否有更新，如果有更新则重新 dispatch 数据并储存数据
    setInterval(() => {
      if (deletedFollowingUsers.changed) {
        this.dispatchFollowingList()
        this.storage()
        deletedFollowingUsers.changed = false
      }
    }, 1000)

    browser.runtime.onInstalled.addListener(async () => {
      // 每次更新或刷新扩展时尝试读取数据，如果数据不存在则设置数据
      const data = await browser.storage.local.get(this.store)
      if (
        data[this.store] === undefined ||
        Array.isArray(data[this.store]) === false
      ) {
        this.storage()
      }
    })

    browser.runtime.onMessage.addListener(
      async (msg: unknown, sender: browser.Runtime.MessageSender) => {
        if (!this.isMsg(msg)) {
          return false
        }

        if (msg.msg === 'requestFollowingData') {
          this.dispatchFollowingList(sender?.tab)
        }

        if (msg.msg === 'needUpdateFollowingData') {
          if (this.uploadStatus === 'locked') {
            // 查询上次执行更新任务的标签页还是否存在，如果不存在，
            // 则改为让这次发起请求的标签页执行更新任务
            const tabs = await this.findAllPixivTab()
            const find = tabs.find((tab) => tab.id === this.updateTaskTabID)
            if (!find) {
              this.updateTaskTabID = sender!.tab!.id!
            } else {
              // 如果上次执行更新任务的标签页依然存在，且状态锁定，则拒绝这次请求
              return
            }
          } else {
            this.updateTaskTabID = sender!.tab!.id!
          }

          this.uploadStatus = 'locked'

          browser.tabs.sendMessage(this.updateTaskTabID, {
            msg: 'updateFollowingData',
          })
        }

        if (msg.msg === 'setFollowingData') {
          const data = msg.data as SetData
          // 当前台获取新的关注列表完成之后，会发送此消息。
          // 如果发送消息的页面和发起请求的页面是同一个，则解除锁定状态
          if (sender!.tab!.id === this.updateTaskTabID) {
            this.uploadStatus = 'idle'
          }
          // 不管数据是否来自于发起请求的页面都更新数据。因为有些操作可能会直接更新数据，没有事先请求批准的环节

          // set 操作不会被放入等待队列中，而且总是会被立即执行
          // 这是因为在请求数据的过程中可能产生了其他操作，set 操作的数据可能已经是旧的了
          // 所以需要先应用 set 里的数据，然后再执行其他操作，在旧数据的基础上进行修改
          this.setData(data)

          // 如果队列中没有等待的操作，则立即派发数据并储存数据
          // 如果有等待的操作，则不派发和储存数据，因为稍后队列执行完毕后也会派发和储存数据
          // 这是为了避免重复派发和储存数据，避免影响性能
          if (this.queue.length === 0) {
            this.dispatchFollowingList()
            this.storage()
          }
        }
      }
    )

    // 监听用户新增或取消一个关注的请求
    // 由于某些逻辑相似，就添加到一个监听器里了
    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.method === 'POST') {
          if (details?.requestBody?.formData) {
            let operate: UserOperate = {
              action: '',
              loggedUserID: '',
              userID: '',
            }

            // 检查数据格式是否是自己需要的，以防这个 URL 有其他用途
            const formData = details.requestBody.formData
            if (details.url.endsWith('bookmark_add.php')) {
              const check =
                formData.mode &&
                formData.mode[0] === 'add' &&
                formData.user_id &&
                formData.user_id[0]
              if (check) {
                operate.action = 'add'
                operate.userID = formData.user_id[0]
              } else {
                return
              }
            }

            if (details.url.endsWith('rpc_group_setting.php')) {
              const check =
                formData.mode &&
                formData.mode[0] === 'del' &&
                formData.type &&
                formData.type[0] === 'bookuser' &&
                formData.id &&
                formData.id[0]
              if (check) {
                operate.action = 'remove'
                operate.userID = formData.id[0]
              } else {
                return
              }
            }

            // 获取发起请求的标签页里的登录的用户 ID
            browser.tabs
              .sendMessage(details.tabId, {
                msg: 'getLoggedUserID',
              })
              .then((response: any) => {
                if (response?.loggedUserID) {
                  operate.loggedUserID = response.loggedUserID
                  this.queue.push(operate)
                  this.executionQueue()
                }
              })
          }
        }
      },
      {
        urls: [
          'https://*.pixiv.net/bookmark_add.php',
          'https://*.pixiv.net/rpc_group_setting.php',
        ],
        types: ['xmlhttprequest'],
      },
      ['requestBody']
    )

    setInterval(() => {
      this.executionQueue()
    }, 1000)

    this.checkDeadlock()

    this.clearUnusedData()
  }

  // 类型守卫
  private isMsg(msg: any): msg is Msg {
    return !!msg.msg
  }

  private readonly store = 'following'

  private data: AllUserFollowingData = []

  private uploadStatus: 'idle' | 'loading' | 'locked' = 'idle'
  private updateTaskTabID = 0
  /**当 uploadStatus 为 locked 时，如果需要增加或删除某个关注的用户，则将其放入等待队列 */
  private queue: UserOperate[] = []

  /** 是否已完成 restore */
  private restored = false

  private async restore() {
    if (this.uploadStatus !== 'idle') {
      return
    }

    this.uploadStatus = 'loading'
    const obj = await browser.storage.local.get(this.store)
    if (obj[this.store] && Array.isArray(obj[this.store])) {
      this.data = obj[this.store] as AllUserFollowingData
      // 这些属性在之前的版本里没有，所以需要添加一下
      this.data.forEach((item) => {
        if (item.followedUsersInfo === undefined) {
          item.followedUsersInfo = []
        }
        if (item.deletedUsers === undefined) {
          item.deletedUsers = []
        }
      })

      this.uploadStatus = 'idle'
      this.restored = true
    } else {
      return setTimeout(() => {
        this.restore()
      }, 500)
    }
  }

  /**向前台脚本派发数据
   * 可以指定向哪个 tab 派发
   * 如果未指定 tab，则向所有的 pixiv 标签页派发
   */
  private async dispatchFollowingList(tab?: browser.Tabs.Tab) {
    // 调试用：重置 deletedUsers 数据
    // this.data.forEach(item => {
    //   item.deletedUsers = []
    // })
    // this.storage()

    if (!this.restored) {
      setTimeout(() => {
        return this.dispatchFollowingList(tab)
      }, 100)
    } else {
      if (tab?.id) {
        browser.tabs.sendMessage(tab.id, {
          msg: 'dispathFollowingData',
          data: this.data,
        })
      } else {
        const tabs = await this.findAllPixivTab()
        for (const tab of tabs) {
          browser.tabs.sendMessage(tab.id!, {
            msg: 'dispathFollowingData',
            data: this.data,
          })
        }
      }
    }
  }

  private async dispatchRecaptchaToken(
    recaptcha_enterprise_score_token: string
  ) {
    const tabs = await this.findAllPixivTab()
    for (const tab of tabs) {
      browser.tabs.sendMessage(tab.id!, {
        msg: 'dispatchRecaptchaToken',
        data: recaptcha_enterprise_score_token,
      })
    }
  }

  private storage() {
    return browser.storage.local.set({ following: this.data })
  }

  /**执行队列中的所有操作 */
  private async executionQueue() {
    if (this.uploadStatus !== 'idle' || this.queue.length === 0) {
      return
    }

    while (this.queue.length > 0) {
      // set 操作不会在此处执行
      const queue = this.queue.shift()!
      await this.addOrRemoveOne(queue)
    }

    // 队列中的所有操作完成后，派发和储存数据
    this.dispatchFollowingList()
    this.storage()
  }

  private setData(data: SetData) {
    const index = this.data.findIndex(
      (following) => following.user === data.user
    )
    if (index > -1) {
      // 对比新旧数据，找出被删除的用户 ID，并将其添加到 deletedUsers 列表中
      const oldFollowing = this.data[index]
      deletedFollowingUsers.whenSetFollowingList(oldFollowing, data.following)

      // 更新当前登录的用户的关注数据
      this.data[index].following = data.following
      this.data[index].total = data.total
      this.data[index].time = new Date().getTime()
      // 历史关注数据采用追加模式，而非直接覆盖
      data.followedUsersInfo.forEach((newUserInfo) => {
        const oldUserInfo = this.data[index].followedUsersInfo.find(
          (userInfo) => userInfo.id === newUserInfo.id
        )
        if (oldUserInfo) {
          oldUserInfo.name = newUserInfo.name
          oldUserInfo.avatar = newUserInfo.avatar
        } else {
          this.data[index].followedUsersInfo.push(newUserInfo)
        }
      })
    } else {
      // 如果之前没有保存过当前登录的用户的关注数据，就新增一份数据
      this.data.push({
        user: data.user,
        following: data.following,
        followedUsersInfo: data.followedUsersInfo,
        total: data.total,
        deletedUsers: [],
        time: new Date().getTime(),
      })
    }
  }

  private async addOrRemoveOne(operate: UserOperate) {
    const i = this.data.findIndex(
      (following) => following.user === operate.loggedUserID
    )
    if (i === -1) {
      return
    }

    if (operate.action === 'add') {
      deletedFollowingUsers.whenAddFollowing(this.data[i], operate.userID)

      this.data[i].following.push(operate.userID)
      this.data[i].total = this.data[i].total + 1

      // 当用户手动关注一个用户时，需要把这个用户的信息添加到 followedUsersInfo 里
      const exist = this.data[i].followedUsersInfo.find(
        (userInfo) => userInfo.id === operate.userID
      )
      if (!exist) {
        try {
          // 调试用：获取一个不存在的用户的信息
          // const userData = await backgroundAPI.getUserProfile('16689973', '0')
          const userData = await backgroundAPI.getUserProfile(
            operate.userID,
            '0'
          )
          this.data[i].followedUsersInfo.push({
            id: operate.userID,
            name: userData.body.name || '',
            avatar: userData.body.imageBig || userData.body.image || '',
          })
        } catch (error: Error | any) {
          console.log(
            `addOrRemoveOne: 获取用户 ${operate.userID} 的信息时出错了`,
            error
          )
        }
      }
    } else if (operate.action === 'remove') {
      deletedFollowingUsers.whenDeleteFollowing(this.data[i], operate.userID)

      // 更新关注列表和总数
      const index = this.data[i].following.findIndex(
        (id) => id === operate.userID
      )
      if (index > -1) {
        this.data[i].following.splice(index, 1)
        this.data[i].total = this.data[i].total - 1
      }
    } else {
      return
    }

    this.data[i].time = new Date().getTime()
  }

  private async findAllPixivTab() {
    const tabs = await browser.tabs.query({
      url: 'https://*.pixiv.net/*',
    })
    return tabs
  }

  /**解除死锁
   * 一个标签页在执行更新任务时可能会被用户关闭，这会导致锁死
   * 定时检查执行更新任务的标签页是否还存在，如果不存在则解除死锁
   */
  private checkDeadlock() {
    setInterval(async () => {
      if (this.uploadStatus === 'locked') {
        const tabs = await this.findAllPixivTab()
        const find = tabs.find((tab) => tab.id === this.updateTaskTabID)
        if (!find) {
          this.uploadStatus = 'idle'
        }
      }
    }, 30000)
  }

  /**如果某个用户的关注数据 30 天没有修改过，则清除对应的数据 */
  private clearUnusedData() {
    setInterval(() => {
      const day30ms = 2592000000
      for (let index = 0; index < this.data.length; index++) {
        const item = this.data[index]
        if (new Date().getTime() - item.time > day30ms) {
          this.data.splice(index, 1)

          this.dispatchFollowingList()
          this.storage()
          break
        }
      }
    }, 3600000)
  }
}

new ManageFollowing()
