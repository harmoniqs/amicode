import sqlite3, time, os, json
src="/home/aaron/.local/share/opencode/opencode.db"
dst="/tmp/opencode/h0b/hubcopy.db"
t=time.time()
s=sqlite3.connect("file:"+src+"?mode=ro", uri=True)
d=sqlite3.connect(dst)
s.backup(d, pages=-1)
d.close(); s.close()
print(json.dumps({"wall_s":time.time()-t,"copy_bytes":os.path.getsize(dst)}))
