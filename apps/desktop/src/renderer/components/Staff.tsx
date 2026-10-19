import { useEffect, useState } from "react";
import { PERMISSIONS, STAFF_ROLES, type Permission } from "@kolo/core/identity/permissions";
import type { Result, RoleView, ShopService, StaffView } from "../../shared/service.ts";
import type { TextKey } from "../text.ts";
import { ErrorText, Field, ReadState, Select, useAction, useRead, useText } from "./ui.tsx";

type Props = { readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly isOwner: boolean };
type MemberRole = Exclude<StaffView["role"], "OWNER">;
const roles: readonly MemberRole[] = ["CASHIER", "MANAGER", "INVENTORY", "ACCOUNTANT"];
const groups: readonly (readonly [TextKey, (permission: Permission) => boolean])[] = [
  ["group_products", permission => permission.startsWith("products.")], ["group_inventory", permission => permission.startsWith("inventory.")],
  ["group_sales", permission => permission.startsWith("sales.")], ["group_customers", permission => permission.startsWith("customers.")],
  ["group_suppliers", permission => permission.startsWith("suppliers.") || permission.startsWith("purchases.")],
  ["group_money", permission => permission.startsWith("cash.") || permission.startsWith("finance.") || permission.startsWith("expenses.")],
  ["group_reports", permission => permission.startsWith("reports.")], ["group_admin", permission => permission.startsWith("users.") || permission.startsWith("business.") || permission.startsWith("data.") || permission.startsWith("audit.")],
];

/** Local staff, their roles and effective permissions, and the shop's role matrix. Only the owner changes them; core rechecks. */
export function Staff({ service, sessionId, revision, isOwner }: Props): React.JSX.Element {
  const { t } = useText();
  const list=useRead(()=>service.listStaff({sessionId}),[service,sessionId,revision]);
  const [selectedId,setSelectedId]=useState<string>(),[creating,setCreating]=useState(false),[tab,setTab]=useState<"members"|"roles">("members");
  const selected=list.data?.find(member=>member.id===selectedId);
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("staff")}</p><h1>{t("staffHelp")}</h1></div>
      {isOwner&&tab==="members"&&selected===undefined&&<button className="primary" onClick={()=>setCreating(true)}>+ {t("newMember")}</button>}</div>
    {!isOwner&&<p className="notice">{t("ownerOnly")}</p>}
    <div className="tabs" role="tablist">{(["members","roles"] as const).map(id=>
      <button key={id} role="tab" aria-selected={tab===id} className={tab===id?"selected":""} onClick={()=>setTab(id)}>{t(id==="members"?"staffMembers":"roles")}</button>)}</div>
    {tab==="roles"?<RoleMatrix service={service} sessionId={sessionId} revision={revision} editable={isOwner}/>:<>
    {creating&&<CreateMember service={service} sessionId={sessionId} onDone={id=>{setCreating(false);if(id!==undefined)setSelectedId(id);}}/>}
    <ReadState loading={list.loading&&list.data===undefined} error={list.error} empty={list.data?.length===0} emptyText={t("noStaff")} retry={list.retry}>
      {selected===undefined?<div className="panel"><div className="table-wrap"><table><thead><tr><th>{t("memberName")}</th><th>{t("role")}</th><th>{t("status")}</th></tr></thead><tbody>
        {list.data?.map(member=><tr key={member.id}><td><button className="row-link" onClick={()=>setSelectedId(member.id)}><strong>{member.name}</strong></button>{member.isSelf&&<small>{t("you")}</small>}</td>
          <td>{t(`role.${member.role}` as TextKey)}</td><td>{member.active?t("active"):<span className="tag">{t("suspended")}</span>}</td></tr>)}
      </tbody></table></div></div>
      :<MemberDetail key={selected.id} service={service} sessionId={sessionId} member={selected} editable={isOwner&&!selected.isSelf&&selected.role!=="OWNER"} onBack={()=>setSelectedId(undefined)}/>}
    </ReadState></>}
  </section>;
}
/** Roles × permissions (ADR-037). A change applies to everyone holding the role, on every till; the owner column is fixed. */
function RoleMatrix({service,sessionId,revision,editable}:{service:ShopService;sessionId:string;revision:number;editable:boolean}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const read=useRead(()=>service.listRoles({sessionId}),[service,sessionId,revision]),[latest,setLatest]=useState<readonly RoleView[]>();
  useEffect(()=>setLatest(undefined),[read.data]);
  const roles=latest??read.data;
  const change=async(work:()=>Promise<Result<readonly RoleView[]>>):Promise<void>=>{const value=await action.run(work);if(value!==undefined)setLatest(value);};
  return <ReadState loading={read.loading&&roles===undefined} error={read.error} empty={false} emptyText="" retry={read.retry}>
    {roles!==undefined&&<div className="panel role-matrix"><p className="hint">{t(editable?"rolesHelp":"rolesReadOnly")}</p><ErrorText message={action.error}/>
      <div className="table-wrap"><table><thead><tr><th scope="col">{t("permissions")}</th><th scope="col">{t("role.OWNER")}</th>
        {STAFF_ROLES.map(role=>{const view=roles.find(item=>item.role===role);return <th key={role} scope="col">{t(`role.${role}` as TextKey)}
          {view?.customized===true&&<small><span className="tag">{t("roleCustomized")}</span>{editable&&<button className="text-button" disabled={action.busy} onClick={()=>{if(window.confirm(t("resetRoleConfirm")))void change(()=>service.resetRole({sessionId,role}));}}>{t("resetRole")}</button>}</small>}</th>;})}</tr></thead>
        {groups.map(([label,matches])=><tbody key={label}><tr className="group-row"><th scope="rowgroup" colSpan={STAFF_ROLES.length+2}>{t(label)}</th></tr>
          {PERMISSIONS.filter(matches).map(permission=><tr key={permission}><th scope="row">{t(`permission.${permission}` as TextKey)}</th>
            <td><input type="checkbox" checked disabled aria-label={`${t("role.OWNER")} · ${t(`permission.${permission}` as TextKey)}`}/></td>
            {STAFF_ROLES.map(role=>{const held=roles.find(item=>item.role===role)?.permissions.includes(permission)===true;
              return <td key={role}><input type="checkbox" checked={held} disabled={!editable||action.busy} aria-label={`${t(`role.${role}` as TextKey)} · ${t(`permission.${permission}` as TextKey)}`}
                onChange={event=>{void change(()=>service.setRolePermission({sessionId,role,permission,allowed:event.target.checked}));}}/></td>;})}</tr>)}</tbody>)}
      </table></div></div>}
  </ReadState>;
}
function CreateMember({service,sessionId,onDone}:{service:ShopService;sessionId:string;onDone:(id?:string)=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [name,setName]=useState(""),[role,setRole]=useState<MemberRole>("CASHIER"),[secret,setSecret]=useState(""),[confirm,setConfirm]=useState("");
  const submit=async():Promise<void>=>{
    if(secret!==confirm){action.setError({code:"codesMismatch"});return;}
    const value=await action.run(()=>service.createStaff({sessionId,name,role,secret}));
    setSecret("");setConfirm("");if(value!==undefined)onDone(value.id);
  };
  return <div className="panel form-panel"><h2>{t("newMember")}</h2><form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={action.busy}>
    <div className="two-fields"><Field id="member-name" label={t("memberName")} value={name} onChange={setName}/>
      <Select id="member-role" label={t("role")} value={role} onChange={value=>setRole(value as MemberRole)} options={roles.map(item=>({value:item,label:t(`role.${item}` as TextKey)}))}/></div>
    <div className="two-fields"><Field id="member-secret" label={t("secret")} value={secret} onChange={setSecret} secret maxLength={256}/><Field id="member-confirm" label={t("confirmSecret")} value={confirm} onChange={setConfirm} secret maxLength={256}/></div>
    <p className="hint">{t("secretHelp")}</p></fieldset>
    <ErrorText message={action.error} inputMessage="identityInput" conflictMessage="duplicateMember"/>
    <div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):t("save")}</button><button type="button" className="secondary" disabled={action.busy} onClick={()=>onDone()}>{t("cancel")}</button></div>
  </form></div>;
}
function MemberDetail({service,sessionId,member,editable,onBack}:{service:ShopService;sessionId:string;member:StaffView;editable:boolean;onBack:()=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [secret,setSecret]=useState(""),[confirm,setConfirm]=useState(""),[replaced,setReplaced]=useState(false);
  const toggle=(permission:Permission,allowed:boolean):void=>{void action.run(()=>service.setStaffPermission({sessionId,userId:member.id,permission,allowed}));};
  const reset=async():Promise<void>=>{
    setReplaced(false);
    if(secret!==confirm){action.setError({code:"codesMismatch"});return;}
    const value=await action.run(async():Promise<Result<StaffView>>=>service.resetStaffSecret({sessionId,userId:member.id,secret}));
    setSecret("");setConfirm("");if(value!==undefined)setReplaced(true);
  };
  return <div className="detail-layout staff-detail">
    <div className="panel"><div className="detail-heading"><button className="secondary" onClick={onBack}>← {t("back")}</button>
      {editable&&<button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.setStaffActive({sessionId,userId:member.id,active:!member.active}));}}>{t(member.active?"suspend":"reinstate")}</button>}</div>
      <h2>{member.name}{!member.active&&<span className="tag">{t("suspended")}</span>}</h2>
      {editable?<Select id="member-role-change" label={t("role")} value={member.role} disabled={action.busy} onChange={value=>{void action.run(()=>service.setStaffRole({sessionId,userId:member.id,role:value as MemberRole}));}}
        options={roles.map(item=>({value:item,label:t(`role.${item}` as TextKey)}))}/>
        :<dl className="facts"><dt>{t("role")}</dt><dd>{t(`role.${member.role}` as TextKey)}</dd></dl>}<ErrorText message={action.error}/>
    </div>
    <div className="panel"><h2>{t("permissions")}</h2>{editable&&<p className="hint">{t("permissionsHelp")}</p>}
      <div className="permission-groups">{groups.map(([label,matches])=><fieldset key={label} className="permission-group" disabled={!editable||action.busy}><legend>{t(label)}</legend>
        {PERMISSIONS.filter(matches).map(permission=><label key={permission} className="check"><input type="checkbox" checked={member.permissions.includes(permission)} onChange={event=>toggle(permission,event.target.checked)}/>{t(`permission.${permission}` as TextKey)}
          {member.exceptions.includes(permission)&&<span className="tag" title={t("exceptionHelp")}>{t("exception")}</span>}</label>)}
      </fieldset>)}</div></div>
    {editable&&<div className="panel form-panel"><h2>{t("resetSecret")}</h2><p className="hint">{t("resetSecretHelp")}</p><form onSubmit={event=>{event.preventDefault();void reset();}}><fieldset disabled={action.busy}>
      <div className="two-fields"><Field id="reset-secret" label={t("newSecret")} value={secret} onChange={setSecret} secret maxLength={256}/><Field id="reset-confirm" label={t("confirmSecret")} value={confirm} onChange={setConfirm} secret maxLength={256}/></div></fieldset>
      {replaced&&<p role="status" className="notice success">{t("secretReplaced")}</p>}
      <div className="actions"><button className="primary" type="submit" disabled={action.busy}>{t("resetSecret")}</button></div></form></div>}
  </div>;
}
