import { DeletedUser, FollowingData } from './FollowingData'
import { backgroundAPI } from './backgroundAPI'

// 这是一个后台脚本
// 当关注列表变化时，保存被删除的用户 ID。这些用户可能是被取消了关注，也可能是账号已经不存在了。
// 它依赖 ManageFollowing 类提供数据源，对数据进行处理之后，把被删除的用户 ID 保存到 FollowingData 的 deletedUsers 数组里。
class DeletedFollowingUsers {
  constructor() {
    setInterval(() => {
      this.updateUserInfo()
    }, 1000)
  }

  private dataSource?: FollowingData
  private updateStatus: 'idle' | 'updating' = 'idle'
  public changed = false

  /** 更新整个关注列表时，找出被删除的用户 ID 并保存到 deletedUsers 中 */
  public whenSetFollowingList(
    dataSource: FollowingData,
    newFollowing: string[]
  ) {
    this.initDeletedUsers(dataSource)

    // 遍历 dataSource.deletedUsers，如果 newFollowing 里含有对应的 userID（可能是用户重新关注了他），则把他从 deletedUsers 里删除
    dataSource.deletedUsers = dataSource.deletedUsers.filter(
      (deletedUser) => !newFollowing.includes(deletedUser.id)
    )

    // 查找被删除的用户 ID
    const deletedUsers = dataSource.following
      .filter((id) => !newFollowing.includes(id))
      .map((id) => ({
        id,
        name: '',
        avatar: '',
        exist: true,
        deleteByUser: false,
        deletedAt: new Date().getTime(),
      }))

    deletedUsers.forEach((user) => {
      const exist = dataSource.deletedUsers!.find((u) => u.id === user.id)
      if (!exist) {
        this.push(user)
      }
    })
  }

  /** 用户主动取消关注某个用户时，把对应的 userID 添加到 deletedUsers里 */
  public whenDeleteFollowing(dataSource: FollowingData, userID: string) {
    this.initDeletedUsers(dataSource)
    const exist = dataSource.deletedUsers.find((u) => u.id === userID)
    if (!exist) {
      this.push({
        id: userID,
        name: '',
        avatar: '',
        exist: true,
        deleteByUser: true,
        deletedAt: new Date().getTime(),
      })
    }
  }

  /** 用户手动关注某个用户时，如果 deletedUsers 里含有对应的 userID，则把他从 deletedUsers 里删除（这说明用户重新关注了他） */
  public whenAddFollowing(dataSource: FollowingData, userID: string) {
    this.initDeletedUsers(dataSource)
    dataSource.deletedUsers = dataSource.deletedUsers.filter(
      (deletedUser) => deletedUser.id !== userID
    )
  }

  private initDeletedUsers(dataSource: FollowingData) {
    this.dataSource = dataSource
    if (!dataSource.deletedUsers) {
      dataSource.deletedUsers = []
    }
  }

  private push(user: DeletedUser) {
    if (!this.dataSource) {
      return
    }

    // 获取用户的名称和头像信息，然后保存
    const userInfo = this.dataSource.followedUsersInfo.find(
      (userInfo) => userInfo.id === user.id
    )
    if (userInfo) {
      user.name = userInfo.name
      user.avatar = userInfo.avatar
    }
    this.dataSource.deletedUsers.push(user)
  }

  // 获取用户的名称和头像信息并保存。每次执行只会获取一个用户的数据
  private async updateUserInfo() {
    if (!this.dataSource || this.updateStatus === 'updating') {
      return
    }

    const user = this.dataSource.deletedUsers.find(
      (deletedUser) =>
        deletedUser.exist && !deletedUser.name && !deletedUser.avatar
    )
    if (!user) {
      return
    }

    try {
      this.updateStatus = 'updating'

      const userData = await backgroundAPI.getUserProfile(user.id, '0')
      // 如果 error 为 true，说明这个用户不存在了
      // 但这个判断条件应该不会被执行，因为此时状态码会是 403
      if (userData.error) {
        user.exist = false
      } else {
        // 检查这个用户是否还在 deletedUsers 里。如果不存在则不修改其信息
        const exist = this.dataSource!.deletedUsers.find(
          (u) => u.id === user.id
        )
        if (exist) {
          // 储存用户信息
          user.name = userData.body.name || ''
          user.avatar = userData.body.imageBig || userData.body.image || ''
          user.exist = true
        }
      }

      // 重新 dispatch 数据，以便内容脚本能拿到更新后的 deletedUsers 数据
      this.changed = true
    } catch (error: Error | any) {
      if (error?.status === 403) {
        console.log(403, user.id)
        user.exist = false
        this.changed = true
      }
    } finally {
      this.updateStatus = 'idle'
    }
  }
}

const deletedFollowingUsers = new DeletedFollowingUsers()
export { deletedFollowingUsers }
