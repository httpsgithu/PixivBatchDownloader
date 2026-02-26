目前 storage.local 里可以保存的数据体积最多是 10 MiB，Chrome 113 及更早版本为 5 MiB。

目前下载器在 storage.local 里保存了这些数据：
- settings 里保存的设置数据
- background 里保存的临时的下载任务数据
- ManageFollowing 里保存的关注列表数据（通常会占据大部分体积）

现在我在里面保存了 5000 个关注用户的数据，加上其他种类的数据，总共占用不到 1 MiB，所以对于大部分用户来说，应该都不会超过限制。

---------

查询当前使用的 storage.local 空间：

```js
chrome.storage.local.getBytesInUse(null).then(bytes => {
  console.log(`${(bytes/1024/1024).toFixed(2)} MiB`)
})
```

---------

在 manifest.json 中声明 "unlimitedStorage" 权限可以使用更大的空间，但目前必要性不大。

另外，Chrome 系的浏览器不会对此权限显示警告信息或请求用户授权，但 Firefox 系浏览器会请求用户授权。
