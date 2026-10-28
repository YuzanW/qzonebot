"""与动态服务平行运行的回复服务：python3 reply_server.py。"""
import json
from http.server import ThreadingHTTPServer

import config
from deepseek_bot import build_request, prepare_comment
from server import FeedHandler, validate_feed


def validate_reply(message):
    validate_feed(message)
    if message.get('messageType') != '回复':
        raise ValueError('只接收回复类型消息。')
    if message.get('messageId') != message['feedId']:
        raise ValueError('messageId必须与目标feedId一致。')
    chain = message.get('commentChain')
    if not isinstance(chain, list) or not chain or not all(isinstance(item, str) for item in chain):
        raise ValueError('缺少评论链。')


def build_reply_request(message):
    payload = build_request(message)
    payload['messages'][0]['content'] += '\n当前任务是回复别人对我的评论的回复。结合原动态和评论链，简短自然地接话。'
    # 上下文仅作为模型输入，浏览器目标始终绑定读取器提交的消息。
    payload['messages'][1]['content'][0]['text'] = json.dumps({
        '原动态': message['text'], '评论链（按页面顺序）': message['commentChain'],
        '任务': '回复这条与我相关消息中的最新回复。',
    }, ensure_ascii=False)
    return payload


def prepare_reply(message):
    command, messages, call_id = prepare_comment(message, request_builder=build_reply_request)
    command.update(type='write_reply', messageId=message['messageId'], commentChain=message['commentChain'])
    return command, messages, call_id


class ReplyHandler(FeedHandler):
    input_path = '/reply'
    result_path = '/reply-result'
    validate = staticmethod(validate_reply)
    prepare = staticmethod(prepare_reply)


if __name__ == '__main__':
    with ThreadingHTTPServer((config.HOST, 8766), ReplyHandler) as server:
        print(f'QQ空间回复服务：http://{config.HOST}:8766/reply；模型：{config.MODEL}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print('\n回复服务已停止。', flush=True)
