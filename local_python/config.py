"""本地配置：后续可在这里修改模型、密钥和提示词。"""
import os

API_KEY = os.environ.get("DEEPSEEK_API_KEY", "sk-12345")
API_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"
SYSTEM_PROMPT = "用简短的话回复动态，发表你的看法。（不一定要是正面评价。）像真人一样锐评，不要像服务用户一样回应动态中的具体提问或需求。通过write_comment工具发表评论。"
API_TIMEOUT = 180
HOST = "127.0.0.1"
PORT = 8765
