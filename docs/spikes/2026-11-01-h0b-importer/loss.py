import sqlite3, json
def conn(p): return sqlite3.connect("file:"+p+"?mode=ro&immutable=1", uri=True)
a=conn("/tmp/opencode/h0b/hubcopy.pristine.db"); b=conn("/tmp/opencode/h0b/hubcopy.db")
out={}
q=lambda c,s: c.execute(s).fetchall()
out["event_by_type_top"]=q(a,"select type,count(*) from event group by type order by 2 desc limit 25")
out["event_distinct_types"]=q(a,"select count(distinct type) from event")[0][0]
out["event_distinct_aggregates"]=q(a,"select count(distinct aggregate_id) from event")[0][0]
out["event_sequence_owner_nonnull_src"]=q(a,"select count(*) from event_sequence where owner_id is not null")[0][0]
out["event_sequence_owner_nonnull_after"]=q(b,"select count(*) from event_sequence where owner_id is not null")[0][0]
out["event_bytes_data"]=q(a,"select sum(length(data)) from event")[0][0]
out["part_by_type_src"]=q(a,"select json_extract(data,'$.type') t,count(*) from part group by t order by 2 desc")
out["file_parts_total"]=q(a,"select count(*) from part where json_extract(data,'$.type')='file'")[0][0]
out["file_parts_nondata"]=q(a,"select count(*) from part where json_extract(data,'$.type')='file' and json_extract(data,'$.url') not like 'data:%'")[0][0]
out["file_parts_nondata_by_user"]=q(a,"""select m.data->>'$.role', count(*) from part p join message m on m.id=p.message_id where json_extract(p.data,'$.type')='file' and json_extract(p.data,'$.url') not like 'data:%' group by 1""")
out["file_parts_nondata_url_scheme"]=q(a,"select substr(json_extract(data,'$.url'),1,instr(json_extract(data,'$.url')||':',':')) s,count(*) from part where json_extract(data,'$.type')='file' and json_extract(data,'$.url') not like 'data:%' group by s order by 2 desc limit 10")
out["message_by_role_src"]=q(a,"select data->>'$.role',count(*) from message group by 1")
out["session_message_by_type_after"]=q(b,"select type,count(*) from session_message group by 1 order by 2 desc")
out["session_message_by_type_src"]=q(a,"select type,count(*) from session_message group by 1 order by 2 desc")
out["session_permission_nonnull_src"]=q(a,"select count(*) from session where permission is not null and permission<>''")[0][0]
out["session_permission_nonnull_after_legacy"]=q(b,"select count(*) from session where permission is not null and permission<>''")[0][0]
out["session_v2_permission_nonnull_after"]=q(b,"select count(*) from session_v2 where permission is not null")[0][0]
out["session_v2_count"]=q(b,"select count(*) from session_v2")[0][0]
out["sessions_missing_in_v2"]=q(b,"select count(*) from session s where not exists(select 1 from session_v2 v where v.id=s.id)")[0][0]
out["sessions_without_messages_src"]=q(a,"select count(*) from session s where not exists(select 1 from message m where m.session_id=s.id)")[0][0]
out["sessions_with_zero_v2_messages_after"]=q(b,"select count(*) from session_v2 s where not exists(select 1 from session_message m where m.session_id=s.id)")[0][0]
out["old_session_message_ids_surviving"]=q(b,"select count(*) from session_message")[0][0]
b.execute("attach database 'file:/tmp/opencode/h0b/hubcopy.pristine.db?mode=ro&immutable=1' as src") if False else None
src_ids=set(r[0] for r in a.execute("select id from session_message"))
aft_ids=set(r[0] for r in b.execute("select id from session_message where id in (%s)"%",".join("'%s'"%i for i in src_ids)))
out["old_637_ids_surviving_after"]=len(aft_ids)
src_sess=q(a,"select count(distinct session_id) from session_message")[0][0]
out["old_session_message_distinct_sessions"]=src_sess
out["cost_sum_legacy"]=q(b,"select sum(cost),sum(tokens_input),sum(tokens_output) from session")[0]
out["cost_sum_v2"]=q(b,"select sum(cost),sum(tokens_input),sum(tokens_output) from session_v2")[0]
b.execute("create temp table x(a)") if False else None
out["project_reassigned"]=q(b,"select count(*) from session s join session_v2 v on v.id=s.id where v.project_id<>s.project_id")[0][0]
out["directory_changed"]=q(b,"select count(*) from session s join session_v2 v on v.id=s.id where v.directory<>s.directory")[0][0]
out["path_set_v2"]=q(b,"select count(*) from session_v2 where path is not null")[0][0]
out["session_v2_by_project"]=q(b,"select project_id,count(*) from session_v2 group by 1 order by 2 desc limit 20")
out["project_after"]=q(b,"select id,worktree from project order by time_created")
out["kv"]=q(b,"select * from kv")
out["data_migration_src"]=q(a,"select * from data_migration")
out["session_input_src"]=q(a,"select id,session_id,delivery,promoted_seq from session_input")
out["session_context_epoch_src_sessions"]=q(a,"select session_id,baseline_seq from session_context_epoch")
out["fk_check_after"]=q(b,"pragma foreign_key_check")[:10]
out["integrity_quick_after"]=q(b,"pragma quick_check")[0][0]
out["migration_after_new_ids"]=[r[0] for r in b.execute("select id from migration where id not in (%s)"%",".join("'%s'"%r[0] for r in a.execute("select id from migration")))]
json.dump(out,open("/tmp/opencode/h0b/raw/loss.json","w"),indent=1,default=str)
for k,v in out.items(): print(k,"=",str(v)[:600])
