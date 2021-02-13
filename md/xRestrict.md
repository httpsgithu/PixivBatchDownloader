作品数据中有一项 `xRestrict`，以前没注意它是什么意思，现在测试了一番，觉得它的作用是标志作品是否为限制级作品。

`
xRestrict: 0 | 1 | 2
`

- 0 非限制级作品
- 1 R-18 作品
- 2 R-18G 作品

测试过程：

在 [综合今日排行榜](https://www.pixiv.net/ranking.php?mode=daily) 的**一般**分类中，抓取所有作品，`xRestrict` 皆为 `0`。

在 [综合R-18每日排行榜](https://www.pixiv.net/ranking.php?mode=daily_r18) 中，抓取所有作品，`xRestrict` 皆为 `1`。

在 [综合R-18G排行榜](https://www.pixiv.net/ranking.php?mode=r18g) 中，抓取所有作品，`xRestrict` 皆为 `2`。
