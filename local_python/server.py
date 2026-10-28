"""动态 -> DeepSeek工具调用 -> 油猴发送者；浏览器执行结果回填工具消息。"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import config
from deepseek_bot import prepare_comment

TASKS = {}
TASK_LOCK = threading.Lock()


def validate_feed(feed):
    if not isinstance(feed, dict) or not isinstance(feed.get("text"), str):
        raise ValueError("text必须是字符串。")
    if not isinstance(feed.get("images"), list):
        raise ValueError("images必须是数组。")
    if not isinstance(feed.get("feedId"), str) or not feed["feedId"].startswith("fct_"):
        raise ValueError("缺少feedId，请更新读取器脚本。")
    if urlparse(feed.get("pageUrl", "")).hostname != "user.qzone.qq.com":
        raise ValueError("pageUrl必须来自QQ空间。")
    for image in feed["images"]:
        if not isinstance(image, dict) or not isinstance(image.get("url"), str):
            raise ValueError("图片必须提供url。")
        if urlparse(image["url"]).scheme not in ("http", "https"):
            raise ValueError("图片链接必须是HTTP(S)链接。")


class FeedHandler(BaseHTTPRequestHandler):
    input_path = "/feed"
    result_path = "/comment-result"
    validate = staticmethod(validate_feed)
    prepare = staticmethod(prepare_comment)

    def do_GET(self):
        if self.path in ("/health", self.input_path):
            self.reply(200, {
                "ok": True, "service": "qzonebot", "protocolVersion": 1,
                "message": f"本地服务已启动；请使用POST {self.input_path}提交任务，不能通过地址栏提交。",
            })
        else:
            self.reply(404, {"ok": False, "error": "unknown path"})

    def reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 4 * 1024 * 1024:
            raise ValueError("请求体大小无效。")
        self.connection.settimeout(10)
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求必须是JSON对象。")
        return payload

    def do_POST(self):
        try:
            payload = self.read_json()
            if self.path == self.input_path:
                self.validate(payload)
                print(f"\n正文：\n{payload['text']}\n检测到的图片数量：{len(payload['images'])}", flush=True)
                try:
                    command, messages, tool_call_id = self.prepare(payload)
                except Exception as error:
                    # 动态已经通过校验；模型或配置错误不应误报成客户端HTTP 400。
                    print(f"生成评论失败：{type(error).__name__}: {error}", flush=True)
                    self.reply(502, {"ok": False, "error": f"生成评论失败：{error}"})
                    return
                with TASK_LOCK:
                    TASKS[command["commandId"]] = {
                        "messages": messages, "tool_call_id": tool_call_id, "result": None,
                    }
                    if len(TASKS) > 100:
                        del TASKS[next(iter(TASKS))]
                print(f"工具write_comment已生成评论：{command['comment']}", flush=True)
                self.reply(200, {"ok": True, "command": command})
            elif self.path == self.result_path:
                command_id = payload.get("commandId")
                if not isinstance(command_id, str) or not isinstance(payload.get("success"), bool):
                    raise ValueError("缺少commandId或success。")
                with TASK_LOCK:
                    task = TASKS.get(command_id)
                    if task is None:
                        self.reply(404, {"ok": False, "error": "评论任务不存在（服务可能已重启）。"})
                        return
                    if task["result"] is None:
                        result = {"success": payload["success"], "error": str(payload.get("error", ""))}
                        task["result"] = result
                        task["messages"].append({
                            "role": "tool", "tool_call_id": task["tool_call_id"],
                            "content": json.dumps(result, ensure_ascii=False),
                        })
                        print(f"评论执行结果：{result}", flush=True)
                self.reply(200, {"ok": True})
            else:
                self.reply(404, {"ok": False, "error": "unknown path"})
        except (ValueError, TypeError, KeyError, IndexError) as error:
            print(f"请求被拒绝：POST {self.path}，HTTP 400：{error}", flush=True)
            self.reply(400, {"ok": False, "error": str(error)})
        except Exception as error:
            print(f"处理失败：{type(error).__name__}: {error}", flush=True)
            self.reply(502, {"ok": False, "error": str(error)})

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    with ThreadingHTTPServer((config.HOST, config.PORT), FeedHandler) as server:
        print(f"QQ空间接收服务：http://{config.HOST}:{config.PORT}/feed", flush=True)
        print(f"模型：{config.MODEL}；等待动态，按Ctrl+C停止。", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已停止。", flush=True)
