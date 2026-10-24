import { useEffect, useState } from "react";
import { PERMISSIONS, STAFF_ROLES, type Permission } from "@kolo/core/identity/permissions";
import type { CustomRoleView, Result, RoleView, ShopService, StaffView } from "../../shared/service.ts";
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
  const custom=useRead(()=>service.listCustomRoles({sessionId}),[service,sessionId,revision]),customRoles=custom.data??[];
  const [selectedId,setSelectedId]=useState<string>(),[creating,setCreating]=useState(false),[tab,setTab]=useState<"members"|"roles">("members");
  const selected=list.data?.find(member=>member.id===selectedId);
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("staff")}</p><h1>{t("staffHelp")}</h1></div>
      {isOwner&&tab==="members"&&selected===undefined&&<button className="primary" onClick={()=>setCreating(true)}>+ {t("newMember")}</button>}</div>
    {!isOwner&&<p className="notice">{t("ownerOnly")}</p>}
    <div className="tabs" role="tablist">{(["members","roles"] as const).map(id=>
      <button key={id} role="tab" aria-selected={tab===id} className={tab===id?"selected":""} onClick={()=>setTab(id)}>{t(id==="members"?"staffMembers":"roles")}</button>)}</div>
    {tab==="roles"?<RoleMatrix service={service} sessionId={sessionId} revision={revision} editable={isOwner}/>:<>
    {creating&&<CreateMember service={service} sessionId={sessionId} customRoles={customRoles} onDone={id=>{setCreating(false);if(id!==undefined)setSelectedId(id);}}/>}
    <ReadState loading={list.loading&&list.data===undefined} error={list.error} empty={list.data?.length===0} emptyText={t("noStaff")} retry={list.retry}>
      {selected===undefined?<div className="panel"><div className="table-wrap"><table><thead><tr><th>{t("memberName")}</th><th>{t("role")}</th><th>{t("status")}</th></tr></thead><tbody>
        {list.data?.map(member=><tr key={member.id}><td><button className="row-link" onClick={()=>setSelectedId(member.id)}><strong>{member.name}</strong></button>{member.isSelf&&<small>{t("you")}</small>}</td>
          <td>{roleLabel(member,t)}</td><td>{member.active?t("active"):<span className="tag">{t("suspended")}</span>}</td></tr>)}
      </tbody></table></div></div>
      :<MemberDetail key={selected.id} service={service} sessionId={sessionId} member={selected} customRoles={customRoles} editable={isOwner&&!selected.isSelf&&selected.role!=="OWNER"} onBack={()=>setSelectedId(undefined)}/>}
    </ReadState></>}
  </section>;
}
/** A member's role in words: their custom role's name when they hold one. */
function roleLabel(member:StaffView,t:(key:TextKey)=>string):React.JSX.Element{
  return member.customRole===undefined?<>{t(`role.${member.role}` as TextKey)}</>:<>{member.customRole.name}{member.customRole.deleted&&<span className="tag">{t("roleDeleted")}</span>}</>;
}
/** Picker values: a built-in role as is, a custom role as `custom:<id>`. */
const CUSTOM="custom:";
function roleOptions(customRoles:readonly CustomRoleView[],t:(key:TextKey)=>string,held?:StaffView["customRole"]):{value:string;label:string;disabled?:boolean}[]{
  return [...roles.map(item=>({value:item,label:t(`role.${item}` as TextKey)})),...customRoles.filter(role=>!role.deleted).map(role=>({value:`${CUSTOM}${role.id}`,label:role.name})),
    ...(held?.deleted===true?[{value:`${CUSTOM}${held.id}`,label:`${held.name} · ${t("roleDeleted")}`,disabled:true}]:[])];
}
/**
 * Roles × permissions (ADR-037), with the shop's own roles after the built-in ones. A change applies to everyone
 * holding the role, on every till; the owner column is fixed.
 */
function RoleMatrix({service,sessionId,revision,editable}:{service:ShopService;sessionId:string;revision:number;editable:boolean}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const read=useRead(()=>service.listRoles({sessionId}),[service,sessionId,revision]),[latest,setLatest]=useState<readonly RoleView[]>();
  const readCustom=useRead(()=>service.listCustomRoles({sessionId}),[service,sessionId,revision]),[latestCustom,setLatestCustom]=useState<readonly CustomRoleView[]>();
  const [form,setForm]=useState<{mode:"new"}|{mode:"rename";role:CustomRoleView}>();
  useEffect(()=>setLatest(undefined),[read.data]);useEffect(()=>setLatestCustom(undefined),[readCustom.data]);
  const roles=latest??read.data,custom=latestCustom??readCustom.data??[];
  const change=async(work:()=>Promise<Result<readonly RoleView[]>>):Promise<void>=>{const value=await action.run(work);if(value!==undefined)setLatest(value);};
  const changeCustom=async(work:()=>Promise<Result<readonly CustomRoleView[]>>):Promise<boolean>=>{const value=await action.run(work);if(value!==undefined)setLatestCustom(value);return value!==undefined;};
  const label=(permission:Permission):string=>t(`permission.${permission}` as TextKey);
  return <ReadState loading={read.loading&&roles===undefined} error={read.error} empty={false} emptyText="" retry={read.retry}>
    {editable&&form===undefined&&<div className="actions"><button className="primary" onClick={()=>{action.setError(undefined);setForm({mode:"new"});}}>+ {t("newRole")}</button></div>}
    {form!==undefined&&<RoleForm key={form.mode==="new"?"new":form.role.id} initial={form.mode==="new"?undefined:form.role} busy={action.busy} onCancel={()=>setForm(undefined)}
      onSave={async(name,baseRole,requestId)=>{if(await changeCustom(()=>form.mode==="new"?service.createCustomRole({sessionId,requestId,name,baseRole}):service.renameCustomRole({sessionId,roleId:form.role.id,name})))setForm(undefined);}}/>}
    {roles!==undefined&&<div className="panel role-matrix"><p className="hint">{t(editable?"rolesHelp":"rolesReadOnly")}</p><ErrorText message={action.error}/>
      <div className="table-wrap"><table><thead><tr><th scope="col">{t("permissions")}</th><th scope="col">{t("role.OWNER")}</th>
        {STAFF_ROLES.map(role=>{const view=roles.find(item=>item.role===role);return <th key={role} scope="col">{t(`role.${role}` as TextKey)}
          {view?.customized===true&&<small><span className="tag">{t("roleCustomized")}</span>{editable&&<button className="text-button" disabled={action.busy} onClick={()=>{if(window.confirm(t("resetRoleConfirm")))void change(()=>service.resetRole({sessionId,role}));}}>{t("resetRole")}</button>}</small>}</th>;})}
        {custom.map(role=><th key={role.id} scope="col">{role.name}{role.deleted&&<span className="tag">{t("roleDeleted")}</span>}
          <small>{`${t("copiedFrom")} ${t(`role.${role.baseRole}` as TextKey)}`}</small>
          {editable&&!role.deleted&&<small><button className="text-button" disabled={action.busy} onClick={()=>{action.setError(undefined);setForm({mode:"rename",role});}}>{t("rename")}</button>
            <button className="text-button" disabled={action.busy||role.holders>0} title={role.holders>0?t("roleInUseHint"):undefined}
              onClick={()=>{if(window.confirm(t("deleteRoleConfirm")))void changeCustom(()=>service.deleteCustomRole({sessionId,roleId:role.id}));}}>{t("deleteRole")}</button></small>}</th>)}</tr></thead>
        {groups.map(([group,matches])=><tbody key={group}><tr className="group-row"><th scope="rowgroup" colSpan={STAFF_ROLES.length+custom.length+2}>{t(group)}</th></tr>
          {PERMISSIONS.filter(matches).map(permission=><tr key={permission}><th scope="row">{label(permission)}</th>
            <td><input type="checkbox" checked disabled aria-label={`${t("role.OWNER")} · ${label(permission)}`}/></td>
            {STAFF_ROLES.map(role=>{const held=roles.find(item=>item.role===role)?.permissions.includes(permission)===true;
              return <td key={role}><input type="checkbox" checked={held} disabled={!editable||action.busy} aria-label={`${t(`role.${role}` as TextKey)} · ${label(permission)}`}
                onChange={event=>{void change(()=>service.setRolePermission({sessionId,role,permission,allowed:event.target.checked}));}}/></td>;})}
            {custom.map(role=><td key={role.id}><input type="checkbox" checked={role.permissions.includes(permission)} disabled={!editable||role.deleted||action.busy} aria-label={`${role.name} · ${label(permission)}`}
              onChange={event=>{void changeCustom(()=>service.setCustomRolePermission({sessionId,roleId:role.id,permission,allowed:event.target.checked}));}}/></td>)}</tr>)}</tbody>)}
      </table></div></div>}
  </ReadState>;
}
/** New custom role (name and the built-in role it starts from) or a rename; one request ID per draft. */
function RoleForm({initial,busy,onSave,onCancel}:{initial?:CustomRoleView|undefined;busy:boolean;onSave:(name:string,baseRole:MemberRole,requestId:string)=>Promise<void>;onCancel:()=>void}):React.JSX.Element{
  const {t}=useText();
  const [name,setName]=useState(initial?.name??""),[baseRole,setBaseRole]=useState<MemberRole>("CASHIER"),[requestId]=useState(()=>crypto.randomUUID());
  return <div className="panel form-panel"><h2>{t(initial===undefined?"newRole":"renameRole")}</h2>
    {initial===undefined&&<p className="hint">{t("newRoleHelp")}</p>}
    <form onSubmit={event=>{event.preventDefault();void onSave(name,baseRole,requestId);}}><fieldset disabled={busy}><div className="two-fields">
      <Field id="custom-role-name" label={t("roleName")} hint={t("hint.roleName")} value={name} onChange={setName} maxLength={60}/>
      {initial===undefined&&<Select id="custom-role-base" label={t("copiedFrom")} hint={t("hint.roleBase")} value={baseRole} onChange={value=>setBaseRole(value as MemberRole)} options={roles.map(item=>({value:item,label:t(`role.${item}` as TextKey)}))}/>}
    </div></fieldset>
    <div className="actions"><button className="primary" type="submit" disabled={busy}>{busy?t("recording"):t("save")}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t("cancel")}</button></div></form></div>;
}
function CreateMember({service,sessionId,customRoles,onDone}:{service:ShopService;sessionId:string;customRoles:readonly CustomRoleView[];onDone:(id?:string)=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [name,setName]=useState(""),[role,setRole]=useState<string>("CASHIER"),[secret,setSecret]=useState(""),[confirm,setConfirm]=useState("");
  const submit=async():Promise<void>=>{
    if(secret!==confirm){action.setError({code:"codesMismatch"});return;}
    const custom=role.startsWith(CUSTOM)?customRoles.find(item=>`${CUSTOM}${item.id}`===role):undefined;
    const value=await action.run(()=>service.createStaff({sessionId,name,secret,...(custom===undefined?{role:role as MemberRole}:{role:custom.baseRole,customRoleId:custom.id})}));
    setSecret("");setConfirm("");if(value!==undefined)onDone(value.id);
  };
  return <div className="panel form-panel"><h2>{t("newMember")}</h2><form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={action.busy}>
    <div className="two-fields"><Field id="member-name" label={t("memberName")} hint={t("hint.memberName")} value={name} onChange={setName}/>
      <Select id="member-role" label={t("role")} hint={t("hint.memberRole")} value={role} onChange={setRole} options={roleOptions(customRoles,t)}/></div>
    <div className="two-fields"><Field id="member-secret" label={t("secret")} hint={t("secretHelp")} value={secret} onChange={setSecret} secret maxLength={256}/><Field id="member-confirm" label={t("confirmSecret")} hint={t("hint.confirmCode")} value={confirm} onChange={setConfirm} secret maxLength={256}/></div></fieldset>
    <ErrorText message={action.error} inputMessage="identityInput" conflictMessage="duplicateMember"/>
    <div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):t("save")}</button><button type="button" className="secondary" disabled={action.busy} onClick={()=>onDone()}>{t("cancel")}</button></div>
  </form></div>;
}
function MemberDetail({service,sessionId,member,customRoles,editable,onBack}:{service:ShopService;sessionId:string;member:StaffView;customRoles:readonly CustomRoleView[];editable:boolean;onBack:()=>void}):React.JSX.Element{
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
      {editable?<Select id="member-role-change" label={t("role")} hint={t("hint.memberRoleChange")} value={member.customRole===undefined?member.role:`${CUSTOM}${member.customRole.id}`} disabled={action.busy}
        onChange={value=>{void action.run(()=>service.setStaffRole(value.startsWith(CUSTOM)?{sessionId,userId:member.id,customRoleId:value.slice(CUSTOM.length)}:{sessionId,userId:member.id,role:value as MemberRole}));}}
        options={roleOptions(customRoles,t,member.customRole)}/>
        :<dl className="facts"><dt>{t("role")}</dt><dd>{roleLabel(member,t)}</dd></dl>}<ErrorText message={action.error}/>
    </div>
    <div className="panel"><h2>{t("permissions")}</h2>{editable&&<p className="hint">{t("permissionsHelp")}</p>}
      <div className="permission-groups">{groups.map(([label,matches])=><fieldset key={label} className="permission-group" disabled={!editable||action.busy}><legend>{t(label)}</legend>
        {PERMISSIONS.filter(matches).map(permission=><label key={permission} className="check"><input type="checkbox" checked={member.permissions.includes(permission)} onChange={event=>toggle(permission,event.target.checked)}/>{t(`permission.${permission}` as TextKey)}
          {member.exceptions.includes(permission)&&<span className="tag" title={t("exceptionHelp")}>{t("exception")}</span>}</label>)}
      </fieldset>)}</div></div>
    {editable&&<div className="panel form-panel"><h2>{t("resetSecret")}</h2><p className="hint">{t("resetSecretHelp")}</p><form onSubmit={event=>{event.preventDefault();void reset();}}><fieldset disabled={action.busy}>
      <div className="two-fields"><Field id="reset-secret" label={t("newSecret")} hint={t("secretHelp")} value={secret} onChange={setSecret} secret maxLength={256}/><Field id="reset-confirm" label={t("confirmSecret")} hint={t("hint.confirmCode")} value={confirm} onChange={setConfirm} secret maxLength={256}/></div></fieldset>
      {replaced&&<p role="status" className="notice success">{t("secretReplaced")}</p>}
      <div className="actions"><button className="primary" type="submit" disabled={action.busy}>{t("resetSecret")}</button></div></form></div>}
  </div>;
}
