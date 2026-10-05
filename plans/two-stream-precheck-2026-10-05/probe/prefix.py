import json, sys, time, threading, urllib.request, random
URL="http://127.0.0.1:18084/v1/chat/completions"; M="mtplx-qwen38-27b-optimized-quality"
src=open('/Users/kanna/code/ai-stack/scripts/kv_concurrency_proxy.py').read()
def prompt(tag):  # ~12K tokens of real code + a unique tag so the two sessions differ
    return f"Session {tag}. Review this file.\n\n" + src[:42000]
def call(msgs, mx):
    body={"model":M,"max_tokens":mx,"temperature":0.6,"chat_template_kwargs":{"enable_thinking":False},"messages":msgs,"stream":True}
    t0=time.time(); ttft=None; n=0
    r=urllib.request.urlopen(urllib.request.Request(URL,json.dumps(body).encode(),{"Content-Type":"application/json"}),timeout=900)
    for line in r:
        if line.startswith(b"data: {") and ttft is None and b'"content"' in line: ttft=time.time()-t0
    return ttft, time.time()-t0
tag=random.randint(0,1<<30)
base={k:[{"role":"user","content":prompt(f"{k}-{tag}")}] for k in "AB"}
for k in "AB":
    print(k,"cold solo  ttft/total %.1f/%.1f"%call(base[k],8))
for k in "AB":
    print(k,"warm solo  ttft/total %.1f/%.1f"%call(base[k]+[{"role":"assistant","content":"ok"},{"role":"user","content":"List 3 functions."}],8))
res={}
def go(k): res[k]=call(base[k]+[{"role":"assistant","content":"ok"},{"role":"user","content":"List 4 classes."}],8)
ts=[threading.Thread(target=go,args=(k,)) for k in "AB"]; T=time.time()
[t.start() for t in ts]; [t.join() for t in ts]
for k in "AB": print(k,"warm CONCURRENT ttft/total %.1f/%.1f"%res[k])
print("wall %.1f"%(time.time()-T))
