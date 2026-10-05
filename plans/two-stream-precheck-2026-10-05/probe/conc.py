import json, sys, time, threading, urllib.request
port, model, n = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
res = {}
def one(i):
    body = {"model": model, "max_tokens": int(sys.argv[4]) if len(sys.argv)>4 else 400, "temperature": 0.6,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": f"[{i}-{time.time()}] Write a Python function that parses ISO-8601 durations like P3DT4H, with a docstring and 5 doctests. Code only."}]}
    t0 = time.time()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=600))
    res[i] = (t0, time.time(), d["usage"]["completion_tokens"])
hs = []
def health():
    while len(res) < n:
        try:
            h = json.load(urllib.request.urlopen(f"http://127.0.0.1:8080/proxy/health", timeout=5)); hs.append(h["active"])
        except Exception: pass
        time.sleep(0.5)
ts = [threading.Thread(target=one, args=(i,)) for i in range(n)]
T = time.time()
for t in ts: t.start()
threading.Thread(target=health, daemon=True).start()
for t in ts: t.join()
for i,(a,b,c) in sorted(res.items()):
    print(f"req{i}: start+{a-T:.1f}s end+{b-T:.1f}s dur {b-a:.1f}s tokens {c} -> {c/(b-a):.1f} tok/s")
print(f"wall {time.time()-T:.1f}s; proxy active samples max={max(hs) if hs else None}")
