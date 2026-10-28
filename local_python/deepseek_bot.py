"""OpenAI兼容的多模态请求，以及模型可调用的评论工具。仅使用标准库。"""
import json
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import config

COMMENT_TOOL = {
    "type": "function",
    "function": {
        "name": "write_comment",
        "description": "为当前动态发表评论",
        "parameters": {
            "type": "object",
            "properties": {"comment": {"type": "string", "description": "要发表的简短评论正文"}},
            "required": ["comment"],
            "additionalProperties": False,
        },
    },
}


def build_request(feed):
    content = [{"type": "text", "text": feed["text"] or "（这条动态没有文字，请结合配图回复。）"}]
    for image in feed["images"]:
        # image_url是实际图片输入，而不是把URL作为普通文字发送。
        content.append({"type": "image_url", "image_url": {"url": image["url"]}})
    return {
        "model": config.MODEL,
        "messages": [
            {"role": "system", "content": config.SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        "tools": [COMMENT_TOOL],
        "tool_choice": {"type": "function", "function": {"name": "write_comment"}},
        "thinking": {"type": "disabled"},
        "max_tokens": 512,
        "stream": False,
    }


def call_deepseek(payload):
    if config.API_KEY == "sk_12345":
        raise ValueError("请先在config.py替换占位密钥sk_12345，或设置DEEPSEEK_API_KEY环境变量。")
    request = Request(
        config.API_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {config.API_KEY}"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=config.API_TIMEOUT) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"DeepSeek请求失败：HTTP {error.code}，请检查密钥、余额及图片链接。") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("DeepSeek网络连接失败或超时。") from error


def write_comment(comment, feed):
    """工具实现：产生浏览器评论任务；目标绑定原始动态，不由模型指定。"""
    if not isinstance(comment, str) or not comment.strip() or len(comment) > 500:
        raise ValueError("评论必须是1至500字符的非空字符串。")
    return {
        "commandId": str(uuid.uuid4()),
        "type": "write_comment",
        "comment": comment.strip(),
        "feedId": feed["feedId"],
        "text": feed["text"],
        "pageUrl": feed["pageUrl"],
    }


def prepare_comment(feed, request_builder=build_request):
    payload = request_builder(feed)
    response = call_deepseek(payload)
    message = response["choices"][0]["message"]
    calls = message.get("tool_calls") or []
    if len(calls) != 1 or calls[0].get("function", {}).get("name") != "write_comment":
        raise ValueError("模型必须返回且仅返回一个write_comment工具调用。")
    call = calls[0]
    arguments = json.loads(call["function"]["arguments"])
    if not isinstance(arguments, dict) or set(arguments) != {"comment"}:
        raise ValueError("write_comment工具参数无效。")
    command = write_comment(arguments["comment"], feed)
    # 保留标准assistant/tool消息供后续扩展；当前不额外请求一次模型。
    return command, payload["messages"] + [message], call["id"]
