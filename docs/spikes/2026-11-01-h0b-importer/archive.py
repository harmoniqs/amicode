import sqlite3, time, hashlib, os, json
src="/tmp/opencode/h0b/hubcopy.pristine.db"; dst="/tmp/opencode/h0b/event-archive.db"
if os.path.exists(dst): os.remove(dst)
t=time.time()
c=sqlite3.connect("file:"+src+"?mode=ro&immutable=1", uri=True)
c.execute("attach database ? as arc", (dst,))
c.execute("create table arc.event as select * from main.event")
c.execute("create table arc.event_sequence as select * from main.event_sequence")
c.commit()
t1=time.time()-t
def fp(con,tbl):
    acc=0;n=0
    for row in con.execute(f'select * from {tbl}'):
        acc^=int.from_bytes(hashlib.sha256(repr(row).encode()).digest()[:16],"big");n+=1
    return n,format(acc,"032x")
a=sqlite3.connect("file:"+dst+"?mode=ro&immutable=1", uri=True)
r={"copy_s":round(t1,1),"archive_bytes":os.path.getsize(dst)}
for tbl in ("event","event_sequence"):
    r[tbl+"_src"]=fp(c,"main."+tbl); r[tbl+"_archive"]=fp(a,tbl)
r["verify_s"]=round(time.time()-t-t1,1)
print(json.dumps(r)); json.dump(r,open("/tmp/opencode/h0b/raw/archive.json","w"),indent=1)
