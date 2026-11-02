import sqlite3, json, sys
p=sys.argv[1]
c=sqlite3.connect("file:"+p+"?mode=ro", uri=True)
out={"tables":{}, "schema":[]}
for n,t,sql in c.execute("select name,type,sql from sqlite_master order by type,name"):
    out["schema"].append({"name":n,"type":t,"sql":sql})
    if t=="table" and not n.startswith("sqlite_"):
        out["tables"][n]=c.execute(f'select count(*) from "{n}"').fetchone()[0]
out["user_version"]=c.execute("pragma user_version").fetchone()[0]
json.dump(out,open(sys.argv[2],"w"),indent=1)
for k,v in out["tables"].items(): print(f"{v:>10} {k}")
