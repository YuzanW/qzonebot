# QQ空间本地机器人

## 使用方法
将6个.js文件拖进浏览器油猴扩展并安装。

在本地启动server.py和reply_server.py

在config.py填入自己的模型配置（默认deepseek-flash）和api key

保持油猴脚本正常运行，开启两个浏览器窗口进入自己的qzone，控制台分别输入
```js
sessionStorage.setItem('qzonebot:mode', 'feed');
location.reload();
```
和
```js
sessionStorage.setItem('qzonebot:mode', 'reply');
location.reload();
```

浏览器推荐使用谷歌。

没有完善提示词。默认系统提示词非常简单，可以在config.py修改。


## 文件与启动


Python 3，仅使用标准库，无需安装依赖。

- `config.py`：DeepSeek官方API地址、模型、密钥和最简提示词。
- `deepseek_bot.py`：OpenAI兼容的Chat Completions请求、图片输入和`write_comment`工具。
- `server.py`：本地HTTP服务、评论任务与工具执行结果。
- 项目根目录中的三个`.user.js`文件：读取器、接收器、发送者。

密钥按要求预填为`sk_12345`。测试前在`config.py`替换成真实密钥，或者设置`DEEPSEEK_API_KEY`环境变量；仍为占位值时服务会明确报错，不请求API。修改配置后重启服务。

```sh
python3 /Users/feixue/Desktop/qzonebot/local_python/server.py
```

保持该终端运行，在油猴中更新`01-qzone-reader.user.js`、`02-qzone-receiver.user.js`，并新增安装`03-qzone-sender.user.js`。三个脚本都启用，允许receiver和sender连接`127.0.0.1`，随后刷新QQ空间好友动态页面。

## 工作流程

1. reader读取最上方动态正文和图片链接，仅按正文完全相同判重。`feedId`仅用于评论定位，不用于判重。
2. 正文相同：保留测试提示和10秒后刷新行为。
3. 正文不同：receiver将信息POST到`http://127.0.0.1:8765/feed`，等待DeepSeek返回工具调用，不弹窗、不刷新。
4. Python终端输出正文、图片数量；使用`deepseek-flash`向`https://api.deepseek.com/chat/completions`发送正文及`image_url`图片内容块，要求调用`write_comment(comment)`。提示词在`config.py`的`SYSTEM_PROMPT`中。
5. 工具函数返回绑定原始动态的评论任务，HTTP响应经receiver转交sender。模型不能指定其他动态或执行任意JavaScript。
6. sender定位该动态，核对正文，打开评论框、填写纯文本、点击“发表”。已有草稿时停止，避免覆盖。
7. sender等待出现“当前账号、新评论ID、内容匹配”的评论记录，再将本次动态正文写入`sessionStorage`，读回确认。然后等待10秒，刷新前再次确认保存的正文仍然一致。
8. sender向`/comment-result`回报结果，Python将其作为标准`role: tool`消息记入内存会话。当前每条动态只请求模型一次，不再请求模型生成一条收尾回复。

图片通过URL交给DeepSeek读取，没有在本地下载。链接必须能被DeepSeek服务访问；若QQ图片链接需要登录、过期或存在访问限制，API可能报错，这时会停止并记录错误，不会悄悄丢弃图片只用文字评论。

模型名`deepseek-flash`使用官方当前Flash别名。2026-10-27核实官方文档时对应DeepSeek-V4.1-Flash-1017，支持图片和工具调用：

- [官方模型说明](https://api-docs.deepseek.com/)
- [图片输入格式](https://api-docs.deepseek.com/guides/vision/)
- [工具调用](https://api-docs.deepseek.com/guides/tool_calls/)

## 临时保存与失败处理

### 服务已启动，但脚本报告HTTP 400

HTTP 400表示请求到达本地服务后被拒绝，不代表端口无法连接。请查看Python窗口中的“请求被拒绝”日志，或接收器输出的具体错误详情。

- 提示缺少`feedId`或`pageUrl`：在油猴管理面板中用项目里的最新版覆盖读取器、接收器，并确认发送者已安装启用；停用重复的旧版脚本。修改本地`.user.js`文件不会自动更新油猴中的副本。
- 提示`text`、`images`或图片链接格式错误：根据错误详情检查读取器提交的数据。
- HTTP 502、“生成评论失败”：检查密钥、模型响应及DeepSeek连接；这与本地请求格式错误分开报告。

修改Python代码后，在IDLE中先停止旧服务，再重新运行`server.py`（或终端中Ctrl+C后重新启动），随后手动刷新QQ空间页面。更新后可打开`http://127.0.0.1:8765/health`检查服务状态；地址栏访问`/feed`也只检查服务存活，不会调用模型或生成评论。

判重记录按当前标签页、当前空间账号保存在`qzonebot:v1:last-text:<账号>`，刷新会保留。首次运行当作新动态；两条正文相同但配图不同仍视为重复，两条空正文也是如此。

正文在评论确认成功后保存。sender点击发表前还会写入`qzonebot:v1:pending-comment:<账号>`，包含本次正文和任务。若点击后超时、验证码或结果不明，保留pending并停留页面，reader遇到pending不会再发评论。请先人工检查实际结果，避免重复发送。

如确认评论已成功但脚本未识别，在网页开发者工具控制台执行下面代码，将pending中的正文保存为已处理并解除暂停；然后手动刷新：

```js
const account = location.pathname.split('/')[1];
const pendingKey = `qzonebot:v1:pending-comment:${account}`;
const pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
if (pending) {
  sessionStorage.setItem(`qzonebot:v1:last-text:${account}`, pending.text);
  sessionStorage.removeItem(pendingKey);
}
```

仅在确认**没有发出评论**且希望重试时，执行以下代码清除任务暂停，然后刷新：

```js
sessionStorage.removeItem(`qzonebot:v1:pending-comment:${location.pathname.split('/')[1]}`);
```

如果你想让已处理的同一条动态重新进入模型流程，可清除last-text记录再刷新（这会允许再次评论）：

```js
sessionStorage.removeItem(`qzonebot:v1:last-text:${location.pathname.split('/')[1]}`);
```

服务只监听本机。更改端口需同时修改`config.py`、receiver的`ENDPOINT`和sender的`RESULT_URL`。按Ctrl+C停止服务。Python任务和工具消息仅保留最近100条内存记录，服务重启会丢失；浏览器判重及pending状态在标签页sessionStorage中，不受Python重启影响。

按本次要求，未执行API联调、油猴扩展测试或实际评论发送。sender的评论框及发表按钮选择器根据当前页面结构编写，发送成功依赖页面出现新评论记录；请自行测试。

## 回复评论并行模块

新增04、05、06三个脚本和 `reply_server.py`（8766端口），按标签页的 `sessionStorage["qzonebot:mode"]` 选择模式。完整启动、模式设置及失败恢复见根目录[回复评论使用说明](../回复评论使用说明.md)。
