import sqlite3, hashlib, json, sys, time
def conn(p): return sqlite3.connect("file:"+p+"?mode=ro&immutable=1", uri=True)
a=conn(sys.argv[1]); b=conn(sys.argv[2])
def cols(c,t): return [r[1] for r in c.execute(f'pragma table_info("{t}")')]
def tables(c): return [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by 1")]
def fp(c,t,cs):
    acc=0;n=0
    q=f'select {",".join(chr(34)+x+chr(34) for x in cs)} from "{t}"'
    for row in c.execute(q):
        h=hashlib.sha256(repr(row).encode()).digest()
        acc^=int.from_bytes(h[:16],"big"); n+=1
    return n,format(acc,"032x")
ta,tb=tables(a),tables(b)
res={"only_in_source":sorted(set(ta)-set(tb)),"only_after":sorted(set(tb)-set(ta)),"tables":{}}
for t in sorted(set(ta)&set(tb)):
    ca,cb=cols(a,t),cols(b,t)
    common=[c for c in ca if c in cb]
    t0=time.time()
    fa=fp(a,t,common); fb=fp(b,t,common)
    res["tables"][t]={"cols_added":[c for c in cb if c not in ca],"cols_dropped":[c for c in ca if c not in cb],
      "rows_src":fa[0],"rows_after":fb[0],"common_cols_hash_equal":fa==fb}
    print(t,res["tables"][t],round(time.time()-t0,1),flush=True)
json.dump(res,open(sys.argv[3],"w"),indent=1)
