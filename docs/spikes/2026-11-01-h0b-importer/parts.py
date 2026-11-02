import sqlite3, json
def conn(p): return sqlite3.connect("file:"+p+"?mode=ro&immutable=1", uri=True)
a=conn("/tmp/opencode/h0b/hubcopy.pristine.db"); b=conn("/tmp/opencode/h0b/hubcopy.db")
out={}
q=lambda c,s: c.execute(s).fetchall()
out["v2_assistant_content_items_by_type"]=q(b,"select json_extract(j.value,'$.type'),count(*) from session_message m, json_each(m.data,'$.content') j where m.type='assistant' group by 1")
out["v2_assistant_tool_state"]=q(b,"select json_extract(j.value,'$.state.status'),count(*) from session_message m, json_each(m.data,'$.content') j where m.type='assistant' and json_extract(j.value,'$.type')='tool' group by 1")
out["v1_tool_state"]=q(a,"select json_extract(data,'$.state.status'),count(*) from part where json_extract(data,'$.type')='tool' group by 1")
out["v2_user_with_files"]=q(b,"select count(*), sum(json_array_length(data,'$.files')) from session_message where type='user' and json_extract(data,'$.files') is not null")
out["v1_text_by_role"]=q(a,"select m.data->>'$.role', p.data->>'$.ignored', p.data->>'$.synthetic', count(*) from part p join message m on m.id=p.message_id where p.data->>'$.type'='text' group by 1,2,3")
v1=set(r[0] for r in a.execute("select id from message")); v2=set(r[0] for r in b.execute("select id from session_message"))
out["v1_ids_without_v2_row"]=len(v1-v2); out["v2_ids_not_in_v1"]=len(v2-v1)
out["v2_synth_by_type"]=q(b,"select type,count(*) from session_message where id not in (select id from message) group by 1")
out["step_start_with_snapshot"]=q(a,"select count(*) from part where data->>'$.type'='step-start' and data->>'$.snapshot' is not null")[0][0]
out["v2_assistant_with_snapshot"]=q(b,"select count(*) from session_message where type='assistant' and json_extract(data,'$.snapshot') is not null")[0][0]
out["compaction_parts_v1"]=64; out["v2_compaction"]=q(b,"select count(*) from session_message where type='compaction'")[0][0]
out["assistant_msgs_with_error_v1"]=q(a,"select count(*) from message where data->>'$.role'='assistant' and data->>'$.error' is not null")[0][0]
out["v2_assistant_with_error"]=q(b,"select count(*) from session_message where type='assistant' and json_extract(data,'$.error') is not null")[0][0]
json.dump(out,open("/tmp/opencode/h0b/raw/parts.json","w"),indent=1,default=str)
for k,v in out.items(): print(k,"=",v)
