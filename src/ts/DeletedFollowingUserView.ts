import browser from 'webextension-polyfill'
import { DeletedUser, FollowingData, DispatchMsg } from './FollowingData'
import { store } from './store/Store'
import { msgBox } from './MsgBox'
import { lang } from './Language'
import { followingList } from './FollowingList'
import { log } from './Log'
import { Utils } from './utils/Utils'
import { API } from './API'
import { toast } from './Toast'
import { EVT } from './EVT'
import { settings } from './setting/Settings'
import { Tools } from './Tools'

class DeletedFollowingUserView {
  constructor() {
    // ManageFollowing 派发关注数据时，保存 deletedUsers 到这个类的副本里备用
    browser.runtime.onMessage.addListener(
      (
        msg: any,
        sender: browser.Runtime.MessageSender,
        sendResponse: Function
      ): any => {
        const m = msg as DispatchMsg
        if (m.msg === 'dispathFollowingData') {
          const deletedUsers = m.data?.find(
            (data) => data.user === store.loggedUserID
          )?.deletedUsers
          if (deletedUsers) {
            this.deletedUsers = deletedUsers
          }
        }
      }
    )
  }

  // 从 FollowingData 里保存 deletedUsers 的副本便于使用
  private deletedUsers: DeletedUser[] = []

  public async check() {
    const tip = lang.transl('_查找已注销的用户')
    EVT.fire('closeCenterPanel')
    toast.show(tip)
    log.warning('🚀' + tip)
    log.log(lang.transl('_检查是否有已注销的用户的说明'))

    // 等待数据更新和派发完成
    await followingList.getList()
    await Utils.sleep(1000)

    // 检查已经不存在于关注列表里，并且不是用户手动取消关注的用户
    const needCheck = this.deletedUsers.filter(
      (user) => user.deleteByUser === false
    )
    if (this.deletedUsers.length === 0 || needCheck.length === 0) {
      this.tipNoResult()
      this.tipComplete()
      return
    }

    const deactivatedUsers: DeletedUser[] = []
    for (const user of needCheck) {
      // 之前已经确定注销了的用户
      if (!user.exist) {
        deactivatedUsers.push(user)
      } else {
        // 检查用户是否已注销
        const link = Tools.createUserLink(user.id, user.name)
        log.log(lang.transl('_检查用户x是否已注销', link))

        let flag = false
        try {
          // 调试用：获取一个不存在的用户的信息
          // const json = await API.getUserProfile('16689973', '0')
          const json = await API.getUserProfile(user.id, '0')
          if (json.error) {
            flag = true
          } else {
            log.log(lang.transl('_该用户未注销'))
          }
        } catch (error: Error | any) {
          if (error?.status === 403) {
            flag = true
          }
        }
        if (flag) {
          user.exist = false
          deactivatedUsers.push(user)
          log.log(lang.transl('_该用户已注销'))
        }

        await Utils.sleep(settings.slowCrawlDealy)
      }
    }

    // 调试用：输出未注销的用户，这是为了在没有已注销用户时也能输出结果，以便检查样式
    // this.output(needCheck.filter(user => user.exist))

    if (deactivatedUsers.length === 0) {
      this.tipNoResult()
    } else {
      this.output(deactivatedUsers)
    }

    this.tipComplete()
  }

  private output(users: DeletedUser[]) {
    log.log(lang.transl('_已注销用户数量') + `: ${users.length}`)
    for (const user of users) {
      let img = ''
      // 输出头像、id、名字
      if (user.avatar) {
        img = `<img src="${user.avatar}" width="50" height="50" style="vertical-align: middle; border-radius: 50%; margin-right: 10px;">`
      }

      const html = `<a href="https://www.pixiv.net/users/${user.id}" target="_blank">
        ${img}
        <span style="margin-right: 10px;">${user.id}</span>
        <span style="margin-right: 10px;">${user.name}</span>
        </a>`
      log.log(html, 2)
    }
  }

  private tipNoResult() {
    const msg = lang.transl('_没有找到已注销的用户')
    msgBox.warning(msg)
    log.warning(msg)
  }

  private tipComplete() {
    const msg = '✅' + lang.transl('_查找已注销的用户')
    log.success(msg)
  }
}

const deletedFollowingUserView = new DeletedFollowingUserView()
export { deletedFollowingUserView }
