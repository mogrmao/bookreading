import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, sendEmailVerification, sendPasswordResetEmail, GoogleAuthProvider,
  signInWithPopup, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, getDocs, onSnapshot, writeBatch,
  runTransaction, arrayUnion, arrayRemove
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

/* ============ helpers ============ */
const WD = ['日','一','二','三','四','五','六'];
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const ymd = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const parseYmd = s => { const [y,m,d] = String(s).split('-').map(Number); return new Date(y,(m||1)-1,d||1); };
const fmtDate = s => { if(!s) return '—'; const d = parseYmd(s); return `${d.getMonth()+1}/${d.getDate()}（${WD[d.getDay()]}）`; };
const fmtShort = s => { const d = parseYmd(s); return `${d.getMonth()+1}/${d.getDate()}`; };
const fmtDateTime = d => `${d.getMonth()+1}/${d.getDate()}（${WD[d.getDay()]}）${pad(d.getHours())}:${pad(d.getMinutes())}`;
const monthKey = d => d.getFullYear()+'-'+pad(d.getMonth()+1);
const monthLabel = k => { const [y,m] = k.split('-'); return `${y} 年 ${Number(m)} 月`; };
const shiftMonth = (k,n) => { const [y,m] = k.split('-').map(Number); return monthKey(new Date(y,m-1+n,1)); };
const uidGen = () => Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const pct = r => r==null ? '—' : Math.round(r*100)+'%';
const normEmail = e => String(e||'').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MEMBERS = 30, MAX_LEADERS = 3, MIN_FORMED = 2;
const AV_COLORS = ['#2E7A69','#4E6FA0','#8A6BB0','#B07A3A','#3F8E9C','#A0565B','#5E8A3C','#6B7280'];
function avColor(id){ let h=0; for(const c of String(id)) h=(h*31+c.charCodeAt(0))>>>0; return AV_COLORS[h%AV_COLORS.length]; }
function avatar(id,name,sm){ const ch=(name||'?').trim().slice(0,1); return `<span class="avatar${sm?' sm':''}" style="background:${avColor(id)}" aria-hidden="true">${esc(ch)}</span>`; }
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
let toastT;
function toast(msg){ let t=$('.toast'); if(!t){ t=document.createElement('div'); t.className='toast'; t.setAttribute('role','status'); document.body.appendChild(t); } t.textContent=msg; clearTimeout(toastT); toastT=setTimeout(()=>t.remove(),3500); }
function fsErr(e){
  const c = e && e.code;
  if (c==='permission-denied') return '沒有權限執行這個動作。';
  if (c==='unavailable') return '目前無法連線，請檢查網路後再試。';
  return '儲存失敗：' + (e && e.message || '請稍後再試');
}
function authErr(e){
  const c = e && e.code || '';
  const map = {
    'auth/invalid-credential':'Email 或密碼不正確。',
    'auth/wrong-password':'Email 或密碼不正確。',
    'auth/user-not-found':'找不到這個帳號，請先註冊。',
    'auth/email-already-in-use':'這個 Email 已經註冊過，請直接登入。',
    'auth/weak-password':'密碼至少需要 6 個字元。',
    'auth/invalid-email':'Email 格式不正確。',
    'auth/too-many-requests':'嘗試次數過多，請稍後再試。',
    'auth/popup-closed-by-user':'已取消 Google 登入。',
    'auth/unauthorized-domain':'這個網址尚未加入 Firebase 授權網域。'
  };
  return map[c] || ('登入失敗：' + (e && e.message || c));
}

/* ============ firebase ============ */
const configured = firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('YOUR_');
let auth = null, db = null;
if (configured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  auth.languageCode = 'zh-TW';
  db = getFirestore(app);
}

/* ============ state ============ */
const TABS = [['overview','書報進度'],['attendance','出席紀錄'],['monthly','參與報表'],['group','小組成員']];
const S = {
  authReady:false, authUser:null, me:'', email:'', authMode:'login',
  groups:[], groupsLoaded:false, gid:lsGet('rc.gid'),
  members:{}, reports:[], sessions:{},           // sessions: { reportId: [session...] }
  view:'app', tab:'overview', month:monthKey(new Date()), attReport:null, dirQuery:'',
  subGid:null, unsubG:null, unsubM:null, unsubR:null, unsubS:{}
};

const curGroup = () => S.groups.find(g=>g.id===S.gid) || null;
const myGroups = () => S.groups.filter(g=>(g.memberUids||[]).includes(S.me));
const isFounder = g => !!g && g.founderUid===S.me;
const isLeader = g => !!g && (g.leaderUids||[]).includes(S.me);
const isFormed = g => ((g?.memberUids)||[]).length >= MIN_FORMED;
const roleOf = (g,u) => g.founderUid===u ? 'founder' : (g.leaderUids||[]).includes(u) ? 'leader' : 'member';
const ROLE_LABEL = {founder:'發起人', leader:'組長', member:'成員'};
const roleTag = r => `<span class="role-tag ${r}">${ROLE_LABEL[r]}</span>`;
const nameOf = u => (S.members[u]?.name) || '成員';
const memberIds = () => (curGroup()?.memberUids) || [];
const myName = () => S.members[S.me]?.name || S.authUser?.displayName || (S.email.split('@')[0]);
const byDate = (a,b) => (a.date||'').localeCompare(b.date||'');
const participantsOf = r => { const ids=memberIds(); const p=(r.participants||[]).filter(u=>ids.includes(u)); return p.length ? p : ids; };
const allSessions = () => S.reports.flatMap(r=>(S.sessions[r.id]||[]).map(s=>({...s, reportId:r.id})));

/* ============ domain ============ */
function coverage(rid){ const set=new Set(); for(const s of (S.sessions[rid]||[])){ const a=+s.fromPart||0, b=+s.toPart||a; if(!a) continue; for(let p=Math.min(a,b); p<=Math.max(a,b); p++) if(p>0) set.add(p); } return set; }
function nextPart(r){ const c=coverage(r.id); for(let p=1;p<=(+r.totalParts||0);p++) if(!c.has(p)) return p; return null; }
function reportDone(r){ const t=+r.totalParts||0; return t>0 && coverage(r.id).size>=t; }
function hasSchedule(r){ const sc=r.schedule; return !!sc && sc.weekday!=='' && sc.weekday!=null; }
function schedLabel(r){ return hasSchedule(r) ? `每週${WD[r.schedule.weekday]} ${r.schedule.time||''}` : '時間未定'; }
function nextMeeting(r){
  if(!hasSchedule(r)) return null;
  const now=new Date(); const [hh,mm]=(r.schedule.time||'20:00').split(':').map(Number);
  let base=now; if(r.startDate && parseYmd(r.startDate)>now) base=parseYmd(r.startDate);
  for(let i=0;i<8;i++){ const d=new Date(base.getFullYear(),base.getMonth(),base.getDate()+i,hh,mm); if(d.getDay()===Number(r.schedule.weekday)&&d>now) return d; }
  return null;
}
/** 已到期的共讀日（今天以前，含今天），最多 n 個 */
function pastMeetingDates(r,n){
  if(!hasSchedule(r)) return [];
  const out=[]; const t=new Date(); const start=r.startDate?parseYmd(r.startDate):null;
  for(let i=0;i<7*n+7 && out.length<n;i++){ const d=new Date(t.getFullYear(),t.getMonth(),t.getDate()-i); if(start&&d<start) break; if(d.getDay()===Number(r.schedule.weekday)) out.push(ymd(d)); }
  return out.reverse();
}
function lastMeetingDate(r){ const p=pastMeetingDates(r,1); return p[0]||ymd(new Date()); }
function status(rate){ if(rate==null) return ['neutral','—']; if(rate>=.8) return ['good','穩定參與']; if(rate>=.5) return ['warn','需關注']; return ['bad','待追蹤']; }
function partLabel(s){ if(!s.fromPart) return ''; return `第 ${s.fromPart}${s.toPart&&s.toPart!=s.fromPart?'–'+s.toPart:''} 篇`; }
function sessionOf(rid,date){ return (S.sessions[rid]||[]).find(s=>s.id===date) || null; }

function monthStats(mk){
  const rmap=Object.fromEntries(S.reports.map(r=>[r.id,r]));
  const sess=allSessions().filter(s=>(s.date||'').startsWith(mk)).sort(byDate);
  const rows=memberIds().map(u=>{
    const mine=sess.filter(s=>participantsOf(rmap[s.reportId]).includes(u));
    let att=0; const seq=mine.map(s=>{ const p=(s.present||[]).includes(u); if(p) att++; return p; });
    let streak=0; for(let i=seq.length-1;i>=0&&!seq[i];i--) streak++;
    return {u,name:nameOf(u),att,total:mine.length,rate:mine.length?att/mine.length:null,streak};
  });
  const rates=sess.map(s=>{ const ps=participantsOf(rmap[s.reportId]); return ps.length ? (s.present||[]).filter(u=>ps.includes(u)).length/ps.length : 0; });
  const avg=rates.length ? rates.reduce((a,b)=>a+b,0)/rates.length : null;
  const full=rows.filter(r=>r.total>0&&r.att===r.total).length;
  const follow=rows.filter(r=>r.rate!=null&&(r.rate<.5||r.streak>=2));
  return {sess,rates,rows,avg,full,follow,rmap};
}

/* ============ data ============ */
function stopGroup(){
  S.unsubM&&S.unsubM(); S.unsubR&&S.unsubR(); Object.values(S.unsubS).forEach(f=>f());
  S.unsubM=S.unsubR=null; S.unsubS={}; S.subGid=null; S.members={}; S.reports=[]; S.sessions={};
}
function stopAll(){ S.unsubG&&S.unsubG(); S.unsubG=null; stopGroup(); S.groups=[]; S.groupsLoaded=false; }

function subscribeGroups(){
  S.unsubG=onSnapshot(collection(db,'groups'), snap=>{
    S.groups=snap.docs.map(d=>({id:d.id,...d.data()})).filter(g=>g.code&&g.founderUid).sort((a,b)=>a.code.localeCompare(b.code));
    S.groupsLoaded=true;
    const mine=myGroups();
    if(!mine.some(g=>g.id===S.gid)) S.gid=mine[0]?.id||null;
    if(!mine.length && S.view!=='join'){ S.view='join'; }
    subscribeGroup(); render();
  }, e=>{ S.groupsLoaded=true; render(); toast(fsErr(e)); });
}
function subscribeGroup(){
  const gid=S.gid;
  if(!gid){ if(S.subGid) stopGroup(); return; }
  if(S.subGid===gid) return;
  stopGroup(); S.subGid=gid;
  S.unsubM=onSnapshot(collection(db,'groups',gid,'members'), snap=>{
    S.members=Object.fromEntries(snap.docs.map(d=>[d.id,d.data()])); render();
  }, ()=>{});
  S.unsubR=onSnapshot(collection(db,'groups',gid,'reports'), snap=>{
    S.reports=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
    const ids=new Set(S.reports.map(r=>r.id));
    for(const rid of Object.keys(S.unsubS)) if(!ids.has(rid)){ S.unsubS[rid](); delete S.unsubS[rid]; delete S.sessions[rid]; }
    for(const r of S.reports) if(!S.unsubS[r.id]){
      S.unsubS[r.id]=onSnapshot(collection(db,'groups',gid,'reports',r.id,'sessions'), s2=>{
        S.sessions[r.id]=s2.docs.map(d=>({id:d.id,...d.data()})); render();
      }, ()=>{});
    }
    render();
  }, ()=>{});
}
const gRef = (...p) => doc(db,'groups',S.gid,...p);
async function run(fn,okMsg){ try{ await fn(); if(okMsg) toast(okMsg); return true; }catch(e){ console.error(e); toast(fsErr(e)); return false; } }
async function commitInChunks(refsToDelete, finalOp){
  for(let i=0;i<refsToDelete.length;i+=400){ const b=writeBatch(db); refsToDelete.slice(i,i+400).forEach(r=>b.delete(r)); await b.commit(); }
  if(finalOp) await finalOp();
}

/* ============ group actions ============ */
async function createGroup(name,note,displayName){
  for(let attempt=0; attempt<6; attempt++){
    const code=String(Math.floor(100000+Math.random()*900000));
    const ref=doc(db,'groups',code);
    try{
      await runTransaction(db, async tx=>{
        const snap=await tx.get(ref);
        if(snap.exists()) throw new Error('code-taken');
        tx.set(ref,{code,name,note,founderUid:S.me,founderName:displayName,leaderUids:[S.me],memberUids:[S.me],createdAt:Date.now(),updatedAt:Date.now()});
        tx.set(doc(db,'groups',code,'members',S.me),{name:displayName,email:S.email,joinedAt:Date.now()});
      });
      return code;
    }catch(e){ if(e.message==='code-taken') continue; throw e; }
  }
  throw new Error('無法產生小組編號，請再試一次');
}
async function joinGroup(g,displayName){
  const b=writeBatch(db);
  b.update(doc(db,'groups',g.id),{memberUids:[...(g.memberUids||[]),S.me]});
  b.set(doc(db,'groups',g.id,'members',S.me),{name:displayName,email:S.email,joinedAt:Date.now()});
  await b.commit();
}
async function leaveGroup(g){
  const b=writeBatch(db);
  const upd={memberUids:(g.memberUids||[]).filter(u=>u!==S.me)};
  if((g.leaderUids||[]).includes(S.me)) upd.leaderUids=g.leaderUids.filter(u=>u!==S.me);
  b.update(doc(db,'groups',g.id),upd);
  b.delete(doc(db,'groups',g.id,'members',S.me));
  await b.commit();
}
async function removeMember(g,u){
  const b=writeBatch(db);
  b.update(doc(db,'groups',g.id),{memberUids:g.memberUids.filter(x=>x!==u),leaderUids:g.leaderUids.filter(x=>x!==u),updatedAt:Date.now()});
  b.delete(doc(db,'groups',g.id,'members',u));
  await b.commit();
}
async function deleteReport(rid){
  const snap=await getDocs(collection(db,'groups',S.gid,'reports',rid,'sessions'));
  const refs=snap.docs.map(d=>d.ref);
  // 先刪出席紀錄，再刪書報（同一批次內最多 400 筆）
  if(refs.length<400){ const b=writeBatch(db); refs.forEach(r=>b.delete(r)); b.delete(gRef('reports',rid)); await b.commit(); }
  else await commitInChunks(refs, async()=>{ const b=writeBatch(db); b.delete(gRef('reports',rid)); await b.commit(); });
}
async function deleteGroup(g){
  const refs=[];
  const reps=await getDocs(collection(db,'groups',g.id,'reports'));
  for(const r of reps.docs){ const ss=await getDocs(collection(db,'groups',g.id,'reports',r.id,'sessions')); ss.docs.forEach(d=>refs.push(d.ref)); refs.push(r.ref); }
  const mem=await getDocs(collection(db,'groups',g.id,'members'));
  mem.docs.filter(d=>d.id!==S.me).forEach(d=>refs.push(d.ref));
  refs.push(doc(db,'groups',g.id,'members',S.me));
  await commitInChunks(refs, async()=>{ const b=writeBatch(db); b.delete(doc(db,'groups',g.id)); await b.commit(); });
}
async function toggleAttendance(rid,date,u){
  const ref=gRef('reports',rid,'sessions',date);
  await runTransaction(db, async tx=>{
    const snap=await tx.get(ref);
    if(!snap.exists()){
      tx.set(ref,{date,present:[u],fromPart:null,toPart:null,note:'',createdBy:S.me,createdAt:Date.now(),updatedAt:Date.now(),updatedBy:S.me});
    } else {
      const on=(snap.data().present||[]).includes(u);
      tx.update(ref,{present:on?arrayRemove(u):arrayUnion(u),updatedAt:Date.now(),updatedBy:S.me});
    }
  });
}

/* ============ auth views ============ */
function renderTop(){
  const tb=$('#topbar'); const brand=tb.querySelector('.brand').outerHTML;
  if(!S.authUser||!S.authUser.emailVerified){ tb.innerHTML=brand; return; }
  const mine=myGroups();
  let pick='';
  if(mine.length){
    pick=`<div class="group-pick"><label for="gsel">小組</label><select id="gsel">${mine.map(x=>`<option value="${esc(x.id)}"${x.id===S.gid&&S.view!=='join'?' selected':''}>${esc(x.name)}（#${esc(x.code)}）${isFormed(x)?'':'・未成團'}</option>`).join('')}</select></div>`;
  }
  const g=curGroup();
  const who=`<div class="me-chip"><span>${esc(myName())}</span>${g&&S.view!=='join'?roleTag(roleOf(g,S.me)):''}</div>`;
  tb.innerHTML=brand+'<div class="spacer"></div>'+pick+`<button class="btn sm${S.view==='join'?' primary':''}" data-act="go-join">＋ 建立／加入小組</button>`+who+'<button class="btn sm ghost" data-act="logout">登出</button>';
}

function viewSetup(){
  return `<div class="card auth-card"><h2>尚未設定 Firebase</h2><p class="muted">請把 Firebase 專案的設定值貼到 <code>firebase-config.js</code>。</p></div>`;
}
function viewAuth(){
  const m=S.authMode;
  const title={login:'登入共讀書報',signup:'註冊會員',reset:'重設密碼'}[m];
  const sub={login:'登入後即可查看你的讀書小組、記錄出席。',signup:'註冊並驗證 Email 後，就可以自創小組或加入現有的小組。',reset:'輸入註冊的 Email，我們會寄送重設密碼連結。'}[m];
  return `<div class="auth-wrap"><div class="card auth-card">
    <h2>${title}</h2><p class="muted" style="margin:6px 0 18px">${sub}</p>
    <form id="authForm" class="grid" style="gap:12px" novalidate>
      ${m==='signup'?`<div class="field"><label for="au-name">姓名（顯示在小組中）</label><input type="text" id="au-name" autocomplete="name" maxlength="20" required></div>`:''}
      <div class="field"><label for="au-email">Email</label><input type="email" id="au-email" autocomplete="email" required></div>
      ${m!=='reset'?`<div class="field"><label for="au-pw">密碼</label><input type="password" id="au-pw" autocomplete="${m==='signup'?'new-password':'current-password'}" minlength="6" required></div>`:''}
      <div class="err" id="au-err" role="alert"></div>
      <button class="btn primary" style="justify-content:center">${{login:'登入',signup:'註冊並寄送驗證信',reset:'寄送重設連結'}[m]}</button>
    </form>
    ${m!=='reset'?`<div class="divider"><span>或</span></div>
    <button class="btn" style="width:100%;justify-content:center" data-act="google">
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>
      使用 Google 帳號${m==='signup'?'註冊':'登入'}</button>`:''}
    <div class="auth-links">
      ${m==='login'?'<button class="btn ghost sm" data-act="auth-mode" data-m="signup">還沒有帳號？註冊會員</button><button class="btn ghost sm" data-act="auth-mode" data-m="reset">忘記密碼</button>':'<button class="btn ghost sm" data-act="auth-mode" data-m="login">返回登入</button>'}
    </div></div></div>`;
}
function viewVerify(){
  return `<div class="auth-wrap"><div class="card auth-card">
    <h2>請驗證你的 Email</h2>
    <p class="muted" style="margin:6px 0 16px">驗證信已寄到 <b>${esc(S.authUser.email)}</b>。點擊信中的連結後，回到這裡按「我已完成驗證」，接著就能選擇自創或加入小組。沒收到的話，請檢查垃圾郵件匣。</p>
    <div class="toolbar"><button class="btn primary" data-act="verified">我已完成驗證</button><button class="btn" data-act="resend">重新寄送驗證信</button><button class="btn ghost" data-act="logout">登出</button></div>
  </div></div>`;
}
async function onAuthSubmit(e){
  e.preventDefault();
  const err=$('#au-err'); err.textContent='';
  const email=normEmail($('#au-email').value); const pw=$('#au-pw')?.value||'';
  if(!EMAIL_RE.test(email)){ err.textContent='請輸入正確的 Email。'; return; }
  const btn=e.target.querySelector('button.primary'); btn.disabled=true;
  try{
    if(S.authMode==='login'){ await signInWithEmailAndPassword(auth,email,pw); }
    else if(S.authMode==='signup'){
      const name=$('#au-name').value.trim(); if(!name){ err.textContent='請輸入姓名。'; btn.disabled=false; return; }
      const cred=await createUserWithEmailAndPassword(auth,email,pw);
      await updateProfile(cred.user,{displayName:name});
      await sendEmailVerification(cred.user);
      S.view='join'; render();
    } else {
      await sendPasswordResetEmail(auth,email);
      toast('已寄出重設密碼信，請到信箱查看。'); S.authMode='login'; render();
    }
  }catch(ex){ err.textContent=authErr(ex); }
  btn.disabled=false;
}

/* ============ main render ============ */
function render(){
  renderTop();
  const app=$('#app');
  if(!configured){ app.innerHTML=viewSetup(); return; }
  if(!S.authReady){ app.innerHTML='<div class="empty"><p>載入中…</p></div>'; return; }
  if(!S.authUser){ app.innerHTML=viewAuth(); $('#authForm').onsubmit=onAuthSubmit; $('#au-email')?.focus(); return; }
  if(!S.authUser.emailVerified){ app.innerHTML=viewVerify(); return; }
  if(!S.groupsLoaded){ app.innerHTML='<div class="empty"><p>正在載入小組資料…</p></div>'; return; }
  const g=curGroup();
  if(S.view==='join'||!g){ app.innerHTML=viewJoin(); mountJoin(); return; }
  const lead=isLeader(g);
  const ls=(g.leaderUids||[]);
  const head=`<div class="ghead"><div style="flex:1;min-width:240px">
      <h1>${esc(g.name)}${isFormed(g)?'':'<span class="pill warn" style="margin-left:10px;vertical-align:middle;font-family:var(--font-body)">未成團</span>'}</h1>
      <div class="sub">小組編號 <b class="num">#${esc(g.code)}</b> · <span class="num">${memberIds().length}</span> / ${MAX_MEMBERS} 位成員${g.note?' · '+esc(g.note):''}</div></div>
      <div class="leaders">${ls.map(u=>`<span class="pill neutral">${esc(nameOf(u))}${u===g.founderUid?'（發起人）':'（組長）'}</span>`).join('')}</div></div>
    <nav class="tabs" role="tablist">${TABS.map(([k,l])=>`<button class="tab" role="tab" aria-selected="${S.tab===k}" data-act="tab" data-k="${k}">${l}</button>`).join('')}</nav>`;
  const notFormed=isFormed(g)?'':`<div class="notice warn" style="margin-bottom:16px"><b>尚未成團：</b>目前只有 ${memberIds().length} 位成員，滿 ${MIN_FORMED} 位即成團。請把小組編號 <b>#${esc(g.code)}</b> 告訴朋友，請他們註冊後搜尋加入。</div>`;
  let body='';
  if(S.tab==='overview') body=viewOverview(g);
  else if(S.tab==='attendance') body=viewAttendance(g);
  else if(S.tab==='monthly') body=viewMonthly(g);
  else body=viewGroup(g);
  app.innerHTML=head+notFormed+body;
  if(S.tab==='group') mountGroup(g);
  void lead;
}

/* ---------- Join / create ---------- */
function viewJoin(){
  const mine=myGroups();
  const first=!mine.length;
  return `<div class="join-head">
      <h1>${first?'歡迎！選擇你的讀書小組':'建立或加入小組'}</h1>
      <p class="muted">${first?'你可以自己發起一個新小組，或從下方清單加入現有的小組。之後也能隨時再加入其他小組。':'每個人都可以發起小組或加入多個小組。'}</p>
      <div class="field" style="max-width:320px;margin-top:12px"><label for="jn-name">我在小組中顯示的名字</label><input type="text" id="jn-name" maxlength="20" value="${esc(myName())}"></div>
    </div>
    <div class="join-grid">
      <section class="card card-pad">
        <div class="section-title"><h2>自創小組</h2><span class="hint">你會成為發起人，可再指定 2 位組長</span></div>
        <form id="createForm" class="grid" style="gap:12px" novalidate>
          <div class="field"><label for="cg-name">小組名稱</label><input type="text" id="cg-name" maxlength="40" placeholder="例如：週三晚間讀書會"></div>
          <div class="field"><label for="cg-note">簡介（選填）</label><input type="text" id="cg-note" maxlength="80" placeholder="例如：每週共讀商業與成長書報"></div>
          <div class="err" id="cg-err" role="alert"></div>
          <div><button class="btn primary">建立小組</button></div>
          <p class="muted" style="font-size:13px;margin:0">建立後系統會給小組一個 6 位數編號，把編號告訴朋友就能找到你的小組。</p>
        </form>
      </section>
      <section class="card card-pad">
        <div class="section-title"><h2>加入小組</h2><span class="hint" id="dirCount"></span></div>
        <div class="field"><label for="dirq">搜尋小組名稱或編號</label><input type="search" id="dirq" placeholder="輸入名稱或 6 位數編號" value="${esc(S.dirQuery)}" autocomplete="off"></div>
        <div id="dirList" class="dir-list"></div>
      </section>
    </div>`;
}
function renderDirectory(){
  const q=S.dirQuery.trim().toLowerCase().replace(/^#/,'');
  const list=S.groups.filter(g=>!q || g.name.toLowerCase().includes(q) || String(g.code).includes(q));
  $('#dirCount').textContent=`共 ${S.groups.length} 個小組${q?`，符合 ${list.length} 個`:''}`;
  $('#dirList').innerHTML = list.length ? list.map(g=>{
    const n=(g.memberUids||[]).length; const joined=(g.memberUids||[]).includes(S.me); const full=n>=MAX_MEMBERS;
    const st=full?'<span class="pill bad">已額滿</span>':isFormed(g)?'<span class="pill good">已成團</span>':'<span class="pill warn">未成團</span>';
    const btn=joined?`<button class="btn sm" data-act="open-group" data-g="${esc(g.id)}">進入</button>`:full?'<button class="btn sm" disabled>已額滿</button>':`<button class="btn sm primary" data-act="join" data-g="${esc(g.id)}">加入</button>`;
    return `<div class="dir-row"><div class="dir-code num">#${esc(g.code)}</div>
      <div class="grow"><div class="t">${esc(g.name)} ${st}</div><div class="s">發起人 ${esc(g.founderName||'—')} · ${n}/${MAX_MEMBERS} 人${g.note?' · '+esc(g.note):''}</div></div>${btn}</div>`;
  }).join('') : `<div class="empty" style="padding:24px"><p>${S.groups.length?'找不到符合的小組，試試其他關鍵字或編號。':'目前還沒有任何小組，你可以自創第一個！'}</p></div>`;
}
function mountJoin(){
  renderDirectory();
  const q=$('#dirq'); q.oninput=()=>{ S.dirQuery=q.value; renderDirectory(); };
  $('#createForm').onsubmit=async e=>{
    e.preventDefault();
    const name=$('#cg-name').value.trim(); const note=$('#cg-note').value.trim(); const dn=$('#jn-name').value.trim();
    const err=$('#cg-err'); err.textContent='';
    if(!dn){ err.textContent='請填寫你在小組中顯示的名字'; return; }
    if(!name){ err.textContent='請輸入小組名稱'; return; }
    const btn=e.target.querySelector('button'); btn.disabled=true;
    try{ const code=await createGroup(name,note,dn); S.gid=code; lsSet('rc.gid',code); S.view='app'; S.tab='overview'; location.hash='overview'; toast(`小組已建立，編號 #${code}`); }
    catch(ex){ err.textContent=fsErr(ex); }
    btn.disabled=false;
  };
}

/* ---------- Overview ---------- */
function viewOverview(g){
  const founder=isFounder(g); const rs=S.reports;
  const st=monthStats(monthKey(new Date()));
  const upcoming=rs.filter(r=>!reportDone(r)).map(r=>nextMeeting(r)).filter(Boolean).sort((a,b)=>a-b)[0];
  const stats=`<div class="stats">
    <div class="card stat"><div class="k">進行中書報</div><div class="v">${rs.filter(r=>!reportDone(r)).length}<small>/ ${rs.length} 本</small></div></div>
    <div class="card stat"><div class="k">本月聚會</div><div class="v">${st.sess.length}<small>場</small></div></div>
    <div class="card stat"><div class="k">本月平均出席率</div><div class="v">${pct(st.avg)}</div></div>
    <div class="card stat"><div class="k">下次聚會</div><div class="v" style="font-size:18px;padding-top:6px">${upcoming?fmtDateTime(upcoming):'—'}</div></div></div>`;
  const cards = !rs.length
    ? `<div class="card empty"><h2 style="font-size:18px">還沒有書報</h2><p>${founder?'新增第一本書報，設定篇數、聚會時間與參與成員。':'發起人新增書報後，進度會顯示在這裡。'}</p>${founder?'<p><button class="btn primary" data-act="report-new">新增書報</button></p>':''}</div>`
    : `<div class="reports">${rs.map(r=>reportCard(g,r)).join('')}</div>`;
  const recent=allSessions().sort(byDate).reverse().slice(0,6);
  const rmap=Object.fromEntries(rs.map(r=>[r.id,r]));
  const recentHtml=recent.length?`<ul class="list">${recent.map(s=>{ const r=rmap[s.reportId]; const ps=participantsOf(r); const n=(s.present||[]).filter(u=>ps.includes(u)).length;
      return `<li><div class="grow"><div class="t">${fmtDate(s.date)}</div><div class="s">${esc(r.title)}${partLabel(s)?' · '+partLabel(s):''}</div></div><span class="pill ${status(ps.length?n/ps.length:null)[0]} num">${n}/${ps.length}</span></li>`; }).join('')}</ul>`:'<p class="muted" style="font-size:14px">尚無聚會紀錄。</p>';
  const memHtml=`<ul class="list">${memberIds().map(u=>`<li>${avatar(u,nameOf(u),true)}<div class="grow"><div class="t">${esc(nameOf(u))}${u===S.me?'（你）':''}</div></div>${roleOf(g,u)!=='member'?roleTag(roleOf(g,u)):''}</li>`).join('')}</ul>`;
  return stats+`<div class="grid cols-main">
    <section><div class="section-title"><h2>書報進度</h2><span class="hint">依聚會紀錄的篇次自動計算</span><div class="spacer"></div>${founder?'<button class="btn primary sm" data-act="report-new">＋ 新增書報</button>':''}</div>${cards}</section>
    <aside class="grid" style="align-content:start">
      <div class="card card-pad"><div class="section-title"><h2>最近聚會</h2></div>${recentHtml}</div>
      <div class="card card-pad"><div class="section-title"><h2>成員</h2><span class="hint num">${memberIds().length} 位</span></div>${memHtml}</div>
    </aside></div>`;
}
function reportCard(g,r){
  const founder=isFounder(g), lead=isLeader(g);
  const total=+r.totalParts||0; const cov=coverage(r.id); const done=Math.min(cov.size,total);
  const p=total?done/total:0; const np=nextPart(r); const nm=nextMeeting(r);
  const last=(S.sessions[r.id]||[]).slice().sort(byDate).pop();
  const ps=participantsOf(r); const iAmIn=ps.includes(S.me);
  const partsViz=total<=60?`<div class="parts" aria-label="各篇完成狀態">${Array.from({length:total},(_,i)=>`<i class="${cov.has(i+1)?'done':''}" title="第 ${i+1} 篇${cov.has(i+1)?'（已讀）':''}"></i>`).join('')}</div>`:'';
  let mine='';
  if(iAmIn && hasSchedule(r)){
    const d=lastMeetingDate(r); const s=sessionOf(r.id,d); const on=!!s&&(s.present||[]).includes(S.me);
    mine=`<div class="mine"><span>${fmtDate(d)} 聚會：${on?'<b class="ok">✓ 我已出席</b>':'尚未記錄'}</span><button class="btn sm${on?'':' primary'}" data-act="toggle" data-r="${esc(r.id)}" data-d="${d}" data-u="${esc(S.me)}">${on?'取消出席':'我有出席'}</button></div>`;
  }
  return `<article class="card rcard">
    <div><h3>${esc(r.title)}</h3>
    <div class="meta" style="margin-top:6px"><span>🗓 ${esc(schedLabel(r))}</span>${r.location?`<span>📍 ${esc(r.location)}</span>`:''}${r.startDate?`<span>自 ${fmtDate(r.startDate)} 起</span>`:''}<span>👥 ${(r.participants||[]).length?`${ps.length} 位參與`:'全體成員'}</span></div></div>
    <div><div class="prog-row"><span><b>${done}</b> / ${total} 篇</span><span class="num">${Math.round(p*100)}%</span></div>
    <div class="bar" style="margin-top:6px"><i style="width:${(p*100).toFixed(1)}%"></i></div></div>
    ${partsViz}
    ${reportDone(r)?'<div class="next"><span>✔ 全部篇數已讀完</span></div>':`<div class="next"><span>下一篇：第 ${np??'—'} 篇</span><span>${nm?'下次聚會 '+fmtDateTime(nm):''}</span></div>`}
    ${mine}
    ${r.note?`<div class="muted" style="font-size:13px">${esc(r.note)}</div>`:''}
    <div class="meta">最近聚會：${last?fmtDate(last.date):'尚無'}</div>
    ${(lead||founder)?`<div class="foot">${lead?`<button class="btn sm primary" data-act="session-new" data-r="${esc(r.id)}">記錄聚會出席</button>`:''}${founder?`<button class="btn sm" data-act="report-edit" data-r="${esc(r.id)}">編輯書報</button>`:''}<button class="btn sm ghost" data-act="see-att" data-r="${esc(r.id)}">出席表</button></div>`:`<div class="foot"><button class="btn sm ghost" data-act="see-att" data-r="${esc(r.id)}">出席表</button></div>`}
  </article>`;
}

/* ---------- Attendance ---------- */
function viewAttendance(g){
  const lead=isLeader(g); const rs=S.reports;
  if(!rs.length) return `<div class="card empty"><p>${isFounder(g)?'請先在「書報進度」新增書報。':'發起人新增書報後，就能在這裡記錄出席。'}</p></div>`;
  if(!rs.some(r=>r.id===S.attReport)) S.attReport=(rs.find(r=>!reportDone(r))||rs[0]).id;
  const r=rs.find(x=>x.id===S.attReport);
  const ps=participantsOf(r);
  const sess=(S.sessions[r.id]||[]);
  const dates=[...new Set([...sess.map(s=>s.id), ...pastMeetingDates(r,8)])].sort().slice(-12);
  const picker=`<select id="attr" style="width:auto" aria-label="選擇書報">${rs.map(x=>`<option value="${esc(x.id)}"${x.id===r.id?' selected':''}>${esc(x.title)}</option>`).join('')}</select>`;
  const help = lead ? '點格子可切換任何成員的出席；點日期可設定該次篇次、備註或刪除。' : (ps.includes(S.me) ? '你可以點自己那一列的格子，記錄自己的出席。' : '你不是這本書報的參與成員，只能查看。');
  const head=`<div class="section-title"><h2>出席紀錄表</h2>${picker}<div class="spacer"></div>${lead?'<button class="btn primary sm" data-act="session-new" data-r="'+esc(r.id)+'">＋ 新增聚會</button>':''}</div><p class="muted" style="font-size:13px;margin:-4px 0 12px">${help}</p>`;
  if(!dates.length) return head+`<div class="card empty"><p>還沒有聚會日期。${lead?'按「新增聚會」開始記錄。':''}</p></div>`;
  const rows=[...ps].sort((a,b)=>(a===S.me?-1:b===S.me?1:0));
  const matrix=`<div class="card tbl-wrap"><table class="matrix"><thead><tr><th class="sticky-col">成員</th>${dates.map(d=>{ const s=sessionOf(r.id,d);
      const lab=`${fmtDate(d)}<small>${s&&s.fromPart?esc(partLabel(s)):(s?'':'未記錄')}</small>`;
      return `<th class="c">${lead?`<button data-act="session-edit" data-r="${esc(r.id)}" data-d="${d}" title="設定這次聚會">${lab}</button>`:lab}</th>`; }).join('')}<th class="n">出席率</th></tr></thead>
    <tbody>${rows.map(u=>{ const can=lead||u===S.me; const recorded=dates.filter(d=>sessionOf(r.id,d)); const att=recorded.filter(d=>(sessionOf(r.id,d).present||[]).includes(u)).length; const rate=recorded.length?att/recorded.length:null;
      return `<tr class="${u===S.me?'me-row':''}"><td class="sticky-col"><div style="display:flex;align-items:center;gap:8px">${avatar(u,nameOf(u),true)}<span>${esc(nameOf(u))}${u===S.me?'（你）':''}</span></div></td>${dates.map(d=>{ const s=sessionOf(r.id,d); const on=!!s&&(s.present||[]).includes(u);
        return `<td class="c">${can?`<button class="cell" data-act="toggle" data-r="${esc(r.id)}" data-d="${d}" data-u="${esc(u)}" aria-label="${esc(nameOf(u))} ${d} ${on?'出席，點擊取消':'未出席，點擊標記出席'}"><span class="dot${on?' on':''}"></span></button>`:`<span class="dot${on?' on':''}" role="img" aria-label="${on?'出席':'未出席'}"></span>`}</td>`; }).join('')}<td class="n"><span class="pill ${status(rate)[0]}">${pct(rate)}</span></td></tr>`; }).join('')}
      <tr><td class="sticky-col muted">出席人數</td>${dates.map(d=>{ const s=sessionOf(r.id,d); return `<td class="c num muted">${s?(s.present||[]).filter(u=>ps.includes(u)).length:0}/${ps.length}</td>`; }).join('')}<td></td></tr></tbody></table></div>`;
  return head+matrix;
}

/* ---------- Monthly ---------- */
function viewMonthly(g){
  const mk=S.month; const st=monthStats(mk);
  const nav=`<div class="monthnav"><button class="btn sm" data-act="month" data-d="-1" aria-label="上個月">‹</button><strong>${monthLabel(mk)}</strong><button class="btn sm" data-act="month" data-d="1" aria-label="下個月">›</button></div>`;
  const tools=`<div class="toolbar"><button class="btn primary" data-act="export">匯出 Excel</button></div>`;
  const kpi=`<div class="stats">
    <div class="card stat"><div class="k">聚會場次</div><div class="v">${st.sess.length}<small>場</small></div></div>
    <div class="card stat"><div class="k">平均出席率</div><div class="v">${pct(st.avg)}</div></div>
    <div class="card stat"><div class="k">全勤成員</div><div class="v">${st.full}<small>位</small></div></div>
    <div class="card stat${st.follow.length?' alert':''}"><div class="k">需追蹤成員</div><div class="v">${st.follow.length}<small>位</small></div></div></div>`;
  if(!st.sess.length) return `<div class="section-title">${nav}<div class="spacer"></div>${tools}</div>`+kpi+`<div class="card empty"><p>${monthLabel(mk)}沒有聚會紀錄。</p></div>`;
  const rows=[...st.rows].sort((a,b)=>(b.rate??-1)-(a.rate??-1)||a.name.localeCompare(b.name,'zh-Hant'));
  const table=`<div class="card tbl-wrap"><table><thead><tr><th>成員</th><th>角色</th><th class="n">出席 / 場次</th><th>出席率</th><th>狀態</th><th class="n">月底連續缺席</th></tr></thead><tbody>
    ${rows.map(r=>{ const [cls,lab]=status(r.rate); return `<tr><td><div style="display:flex;align-items:center;gap:8px">${avatar(r.u,r.name,true)}${esc(r.name)}</div></td><td>${roleTag(roleOf(g,r.u))}</td>
      <td class="n">${r.att} / ${r.total}</td><td><div class="ratebar"><div class="bar"><i class="${cls==='good'?'':cls}" style="width:${((r.rate||0)*100).toFixed(0)}%"></i></div><span class="num" style="width:40px;text-align:right">${pct(r.rate)}</span></div></td>
      <td><span class="pill ${cls}">${lab}</span></td><td class="n">${r.streak>=2?`<span class="pill bad">${r.streak} 次</span>`:(r.streak||'—')}</td></tr>`; }).join('')}
  </tbody></table></div>`;
  const follow=st.follow.length?`<div class="card card-pad"><div class="section-title"><h2>建議追蹤</h2><span class="hint">出席率低於 50% 或月底連續缺席 2 次以上</span></div><ul class="list">${st.follow.map(r=>`<li>${avatar(r.u,r.name,true)}<div class="grow"><div class="t">${esc(r.name)}</div><div class="s">本月出席 ${r.att}/${r.total}（${pct(r.rate)}）${r.streak>=2?`，已連續缺席 ${r.streak} 次`:''}</div></div></li>`).join('')}</ul></div>`
    :`<div class="card card-pad"><div class="section-title"><h2>建議追蹤</h2></div><p class="muted" style="font-size:14px">本月沒有需要追蹤的成員。</p></div>`;
  return `<div class="section-title">${nav}<div class="spacer"></div>${tools}</div>`+kpi+
    `<div class="grid cols-main" style="margin-bottom:16px"><div class="card card-pad chart"><div class="section-title"><h2>每場出席率</h2></div>${chartSvg(st)}</div>${follow}</div>`+
    `<div class="section-title"><h2>成員參與明細</h2></div>`+table;
}
function chartSvg(st){
  const sess=st.sess; const n=sess.length; const W=Math.max(620,n*64+48), H=210, L=40, T=16, B=36, ch=H-T-B, step=(W-L-8)/n, bw=Math.min(34,step*.55);
  let g=''; [0,.5,1].forEach(v=>{ const y=T+ch*(1-v); g+=`<line class="gl" x1="${L}" x2="${W-4}" y1="${y}" y2="${y}"/><text class="ax" x="${L-8}" y="${y+4}" text-anchor="end">${v*100}%</text>`; });
  sess.forEach((s,i)=>{ const r=st.rates[i]; const h=Math.max(2,ch*r); const x=L+step*i+(step-bw)/2; const y=T+ch-h;
    g+=`<rect class="b" x="${x}" y="${y}" width="${bw}" height="${h}" rx="4"><title>${esc(s.date)} ${esc(st.rmap[s.reportId].title)}</title></rect><text class="bl" x="${x+bw/2}" y="${y-5}" text-anchor="middle">${Math.round(r*100)}%</text><text class="ax" x="${x+bw/2}" y="${H-14}" text-anchor="middle">${fmtShort(s.date)}</text>`; });
  return `<div class="tbl-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每場聚會出席率長條圖" style="min-width:${Math.min(W,520)}px;max-height:260px">${g}</svg></div>`;
}

/* ---------- Group / members ---------- */
function viewGroup(g){
  const founder=isFounder(g); const ids=memberIds(); const lc=(g.leaderUids||[]).length;
  const rows=ids.map(u=>{ const role=roleOf(g,u); const m=S.members[u]||{};
    let ctl='';
    if(founder && u!==g.founderUid){
      ctl=`<select class="role-sel" data-u="${esc(u)}" aria-label="${esc(nameOf(u))} 的角色"><option value="member"${role==='member'?' selected':''}>成員</option><option value="leader"${role==='leader'?' selected':''}${role!=='leader'&&lc>=MAX_LEADERS?' disabled':''}>組長</option></select>
        <button class="btn sm danger" data-act="m-remove" data-u="${esc(u)}">移出</button>`;
    } else ctl=roleTag(role);
    return `<tr><td><div style="display:flex;align-items:center;gap:10px">${avatar(u,nameOf(u))}<div><div>${esc(nameOf(u))}${u===S.me?'（你）':''}</div><div class="muted" style="font-size:12px">${esc(m.email||'')}</div></div></div></td>
      <td class="muted num">${m.joinedAt?ymd(new Date(m.joinedAt)):'—'}</td><td><div class="toolbar" style="justify-content:flex-end">${ctl}</div></td></tr>`; }).join('');
  const info = founder ? `<div class="card card-pad"><div class="section-title"><h2>小組資訊</h2><span class="hint">只有發起人可以修改</span></div>
      <div class="row2"><div class="field"><label for="gname">小組名稱</label><input type="text" id="gname" maxlength="40" value="${esc(g.name)}"></div>
      <div class="field"><label for="gnote">簡介（選填）</label><input type="text" id="gnote" maxlength="80" value="${esc(g.note||'')}"></div></div>
      <div class="toolbar mt"><button class="btn primary" data-act="g-save">儲存</button></div></div>` : '';
  const myself=`<div class="card card-pad"><div class="section-title"><h2>我的顯示名稱</h2></div>
      <div class="toolbar"><input type="text" id="myname" maxlength="20" value="${esc(nameOf(S.me))}" style="max-width:240px" aria-label="我的顯示名稱"><button class="btn" data-act="name-save">更新</button></div></div>`;
  const danger = founder
    ? `<div class="card card-pad"><div class="section-title"><h2>刪除小組</h2><span class="hint">會一併刪除所有書報與出席紀錄，無法復原。</span><div class="spacer"></div><button class="btn danger" data-act="g-delete">刪除這個小組</button></div></div>`
    : `<div class="card card-pad"><div class="section-title"><h2>退出小組</h2><span class="hint">退出後你的出席紀錄會保留在小組中。</span><div class="spacer"></div><button class="btn danger" data-act="g-leave">退出這個小組</button></div></div>`;
  return `<div class="grid" style="max-width:900px">
    <div class="notice"><b>邀請朋友加入：</b>請對方到本網站註冊會員，在「加入小組」搜尋編號 <b class="num">#${esc(g.code)}</b> 或小組名稱「${esc(g.name)}」即可加入。</div>
    <div class="card card-pad"><div class="section-title"><h2>成員名單</h2><span class="counter">成員 <b class="num">${ids.length}</b> / ${MAX_MEMBERS} · 組長（含發起人）<b class="num">${lc}</b> / ${MAX_LEADERS}</span></div>
      <div class="tbl-wrap"><table><thead><tr><th>成員</th><th>加入日期</th><th style="text-align:right">${founder?'角色設定':'角色'}</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${founder?'<p class="muted" style="font-size:13px;margin:10px 0 0">組長可以記錄所有成員的出席；發起人另可管理書報、參與成員與小組名單。</p>':''}</div>
    ${info}${myself}${danger}</div>`;
}
function mountGroup(g){
  document.querySelectorAll('.role-sel').forEach(sel=>sel.onchange=async()=>{
    const u=sel.dataset.u; const toLeader=sel.value==='leader';
    let leaders=(g.leaderUids||[]).filter(x=>x!==u); if(toLeader) leaders=[...leaders,u];
    if(leaders.length>MAX_LEADERS){ toast(`組長最多 ${MAX_LEADERS} 位（含發起人）`); sel.value='member'; return; }
    await run(()=>setDoc(doc(db,'groups',g.id),{leaderUids:leaders,updatedAt:Date.now()},{merge:true}), toLeader?`已將 ${nameOf(u)} 設為組長`:`${nameOf(u)} 已改為成員`);
  });
}

/* ============ modals ============ */
function openModal(title,body,foot,wide){
  const root=$('#modal-root');
  root.innerHTML=`<div class="overlay" data-act="ov"><div class="modal${wide?' wide':''}" role="dialog" aria-modal="true" aria-labelledby="mt"><header><h2 id="mt">${esc(title)}</h2><button class="x" type="button" data-act="close" aria-label="關閉">×</button></header><form id="mform" novalidate><div class="body">${body}</div><footer>${foot}</footer></form></div></div>`;
  const f=root.querySelector('input,select,textarea'); f&&f.focus();
  return $('#mform');
}
const closeModal=()=>{ $('#modal-root').innerHTML=''; };

function memberChecks(ids,checked,prefix){
  return `<div class="checks">${ids.map((u,i)=>`<label class="check"><input type="checkbox" id="${prefix}-${i}" value="${esc(u)}"${checked.includes(u)?' checked':''}>${esc(nameOf(u))}</label>`).join('')}</div>`;
}

function reportModal(r){
  const isNew=!r; r=r||{title:'',totalParts:10,schedule:{weekday:3,time:'20:00'},startDate:ymd(new Date()),location:'',note:'',participants:[]};
  const ids=memberIds(); const specific=(r.participants||[]).length>0;
  const f=openModal(isNew?'新增書報':'編輯書報',`
    <div class="field"><label for="rp-title">書名</label><input type="text" id="rp-title" maxlength="60" value="${esc(r.title)}" placeholder="例如：《原子習慣》"></div>
    <div class="row3"><div class="field"><label for="rp-parts">篇數</label><input type="number" id="rp-parts" min="1" max="500" value="${esc(r.totalParts)}"></div>
      <div class="field"><label for="rp-wd">每週聚會日</label><select id="rp-wd">${WD.map((w,i)=>`<option value="${i}"${Number(r.schedule?.weekday)===i?' selected':''}>星期${w}</option>`).join('')}</select></div>
      <div class="field"><label for="rp-time">聚會時間</label><input type="time" id="rp-time" value="${esc(r.schedule?.time||'20:00')}"></div></div>
    <div class="row2"><div class="field"><label for="rp-start">開始日期</label><input type="date" id="rp-start" value="${esc(r.startDate||'')}"></div>
      <div class="field"><label for="rp-loc">地點或會議連結（選填）</label><input type="text" id="rp-loc" maxlength="120" value="${esc(r.location||'')}"></div></div>
    <div class="field"><div class="lbl">參與成員</div>
      <div class="toolbar"><label class="check" style="flex:none"><input type="radio" name="rp-pm" id="rp-all" value="all"${specific?'':' checked'}>全體成員（含之後加入的人）</label><label class="check" style="flex:none"><input type="radio" name="rp-pm" id="rp-some" value="some"${specific?' checked':''}>指定成員</label></div>
      <div id="rp-plist" style="${specific?'':'display:none'}">${memberChecks(ids,specific?r.participants:ids,'rpm')}</div></div>
    <div class="field"><label for="rp-note">備註（選填）</label><textarea id="rp-note" rows="2" maxlength="300">${esc(r.note||'')}</textarea></div>
    <div class="err" id="rp-err" role="alert"></div>`,
    `${isNew?'':'<button type="button" class="btn danger" data-act="report-del" data-r="'+esc(r.id)+'" style="margin-right:auto">刪除書報</button>'}<button type="button" class="btn" data-act="close">取消</button><button class="btn primary">${isNew?'新增':'儲存'}</button>`, true);
  const sync=()=>{ $('#rp-plist').style.display=$('#rp-some').checked?'':'none'; };
  $('#rp-all').onchange=sync; $('#rp-some').onchange=sync;
  f.onsubmit=async e=>{ e.preventDefault();
    const title=$('#rp-title').value.trim(); const parts=parseInt($('#rp-parts').value,10);
    if(!title){ $('#rp-err').textContent='請輸入書名'; return; }
    if(!(parts>=1&&parts<=500)){ $('#rp-err').textContent='篇數需介於 1–500'; return; }
    let participants=[];
    if($('#rp-some').checked){ participants=[...f.querySelectorAll('#rp-plist input:checked')].map(x=>x.value); if(!participants.length){ $('#rp-err').textContent='請至少勾選一位參與成員'; return; } }
    const id=r.id||'r'+uidGen();
    const data={title,totalParts:parts,schedule:{weekday:Number($('#rp-wd').value),time:$('#rp-time').value||'20:00'},startDate:$('#rp-start').value,location:$('#rp-loc').value.trim(),note:$('#rp-note').value.trim(),participants,createdAt:r.createdAt||Date.now(),updatedAt:Date.now()};
    if(await run(()=>setDoc(gRef('reports',id),data), isNew?'書報已新增':'已儲存')) closeModal();
  };
}

function sessionModal(rid,date){
  const r=S.reports.find(x=>x.id===rid); if(!r) return;
  const existing=date?sessionOf(rid,date):null; const ps=participantsOf(r);
  const np=nextPart(r)||1;
  const s=existing||{date:date||lastMeetingDate(r),fromPart:np,toPart:np,present:[],note:''};
  const f=openModal(existing?'設定聚會出席':'新增聚會',`
    <div class="muted" style="font-size:14px">書報：<b style="color:var(--ink)">${esc(r.title)}</b></div>
    <div class="row3"><div class="field"><label for="ss-date">聚會日期</label><input type="date" id="ss-date" value="${esc(s.date)}"></div>
      <div class="field"><label for="ss-from">本次從第幾篇</label><input type="number" id="ss-from" min="1" value="${esc(s.fromPart??'')}"></div>
      <div class="field"><label for="ss-to">到第幾篇</label><input type="number" id="ss-to" min="1" value="${esc(s.toPart??'')}"></div></div>
    <div class="field"><div class="lbl" style="display:flex;justify-content:space-between;align-items:center">出席成員 <span><span id="ss-cnt" class="num"></span> <button type="button" class="btn sm ghost" id="ss-all">全選</button><button type="button" class="btn sm ghost" id="ss-none">清除</button></span></div>
      ${memberChecks(ps,s.present||[],'ck')}</div>
    <div class="field"><label for="ss-note">備註（選填）</label><input type="text" id="ss-note" maxlength="200" value="${esc(s.note||'')}" placeholder="例如：由林怡君導讀"></div>
    <div class="err" id="ss-err" role="alert"></div>`,
    `${existing?'<button type="button" class="btn danger" data-act="session-del" data-r="'+esc(rid)+'" data-d="'+esc(existing.id)+'" style="margin-right:auto">刪除這次聚會</button>':''}<button type="button" class="btn" data-act="close">取消</button><button class="btn primary">儲存</button>`, true);
  const boxes=()=>[...f.querySelectorAll('.checks input')];
  const cnt=()=>$('#ss-cnt').textContent=`${boxes().filter(b=>b.checked).length} / ${ps.length} 位`;
  boxes().forEach(b=>b.onchange=cnt); cnt();
  $('#ss-all').onclick=()=>{ boxes().forEach(b=>b.checked=true); cnt(); };
  $('#ss-none').onclick=()=>{ boxes().forEach(b=>b.checked=false); cnt(); };
  f.onsubmit=async e=>{ e.preventDefault();
    const d=$('#ss-date').value; const a=parseInt($('#ss-from').value,10)||null; const b=parseInt($('#ss-to').value,10)||a;
    if(!DATE_RE.test(d)){ $('#ss-err').textContent='請選擇聚會日期'; return; }
    if(a && (a<1||b<a||b>(+r.totalParts||0))){ $('#ss-err').textContent=`篇次需介於 1–${r.totalParts}，且「到」不可小於「從」`; return; }
    if(d!==(existing?.id) && sessionOf(rid,d)){ $('#ss-err').textContent='這一天已經有聚會紀錄，請直接點表格上的日期修改'; return; }
    // 保留不在參與名單中的既有出席紀錄
    const keep=(s.present||[]).filter(u=>!ps.includes(u));
    const data={date:d,fromPart:a,toPart:a?b:null,present:[...keep,...boxes().filter(x=>x.checked).map(x=>x.value)],note:$('#ss-note').value.trim(),
      createdBy:existing?.createdBy||S.me,createdAt:existing?.createdAt||Date.now(),updatedAt:Date.now(),updatedBy:S.me};
    const ok=await run(async()=>{
      const bt=writeBatch(db);
      if(existing && existing.id!==d) bt.delete(gRef('reports',rid,'sessions',existing.id));
      bt.set(gRef('reports',rid,'sessions',d),data);
      await bt.commit();
    },'出席紀錄已儲存');
    if(ok) closeModal();
  };
}

function confirmModal(title,msg,okLabel,onOk){
  const f=openModal(title,`<p style="margin:0">${msg}</p>`,`<button type="button" class="btn" data-act="close">取消</button><button class="btn danger" style="background:var(--bad);color:#fff;border-color:var(--bad)">${esc(okLabel)}</button>`);
  f.onsubmit=async e=>{ e.preventDefault(); f.querySelector('button.danger').disabled=true; await onOk(); closeModal(); };
}

/* ---------- Excel export ---------- */
function exportExcel(){
  if(!window.XLSX){ toast('Excel 元件尚未載入，請稍後再試'); return; }
  const g=curGroup(); const mk=S.month; const st=monthStats(mk); const ids=memberIds(); const rs=S.reports;
  const sum=[[`${g.name}（#${g.code}）｜${monthLabel(mk)} 參與報表`],[],['聚會場次',st.sess.length],['平均出席率',st.avg==null?'':Math.round(st.avg*1000)/10+'%'],['全勤成員',st.full],['需追蹤成員',st.follow.length],[],
    ['成員','角色','Email','出席','應出席場次','出席率','狀態','月底連續缺席']];
  st.rows.forEach(r=>sum.push([r.name,ROLE_LABEL[roleOf(g,r.u)],S.members[r.u]?.email||'',r.att,r.total,r.rate==null?'':Math.round(r.rate*1000)/10+'%',status(r.rate)[1],r.streak]));
  const det=[['成員',...st.sess.map(s=>`${s.date} ${st.rmap[s.reportId].title}${s.fromPart?' 第'+s.fromPart+(s.toPart&&s.toPart!=s.fromPart?'-'+s.toPart:'')+'篇':''}`),'出席次數']];
  ids.forEach(u=>{ let c=0; det.push([nameOf(u),...st.sess.map(s=>{ if(!participantsOf(st.rmap[s.reportId]).includes(u)) return '—'; const p=(s.present||[]).includes(u); if(p) c++; return p?'✓':'✗'; }),c]); });
  const prog=[['書名','總篇數','已讀篇數','完成度','聚會時間','開始日期','地點','參與成員']];
  rs.forEach(r=>{ const t=+r.totalParts||0, d=Math.min(coverage(r.id).size,t); prog.push([r.title,t,d,t?Math.round(d/t*100)+'%':'',schedLabel(r),r.startDate||'',r.location||'',(r.participants||[]).length?participantsOf(r).map(nameOf).join('、'):'全體成員']); });
  const all=[['日期','書報','篇次','出席人數','參與人數','出席成員','缺席成員','備註']];
  allSessions().sort(byDate).forEach(s=>{ const r=st.rmap[s.reportId]; const ps=participantsOf(r); const p=ps.filter(u=>(s.present||[]).includes(u)); const a=ps.filter(u=>!(s.present||[]).includes(u));
    all.push([s.date,r.title,s.fromPart?(s.fromPart==s.toPart||!s.toPart?String(s.fromPart):`${s.fromPart}-${s.toPart}`):'',p.length,ps.length,p.map(nameOf).join('、'),a.map(nameOf).join('、'),s.note||'']); });
  const wb=XLSX.utils.book_new();
  const add=(rows,name,widths)=>{ const ws=XLSX.utils.aoa_to_sheet(rows); ws['!cols']=widths.map(w=>({wch:w})); XLSX.utils.book_append_sheet(wb,ws,name); };
  add(sum,'月報摘要',[16,8,26,8,10,10,10,14]);
  add(det,'本月出席明細',[14,...st.sess.map(()=>24),10]);
  add(prog,'書報進度',[28,8,10,10,16,12,20,30]);
  add(all,'全部出席紀錄',[12,24,8,10,10,40,30,24]);
  XLSX.writeFile(wb,`${g.name}_${mk}_參與報表.xlsx`);
}

/* ============ events ============ */
document.addEventListener('click',async e=>{
  const el=e.target.closest('[data-act]'); if(!el) return; const a=el.dataset.act;
  const g=curGroup();
  if(a==='ov'){ if(e.target===el) closeModal(); return; }
  if(a==='close'){ closeModal(); return; }
  if(a==='auth-mode'){ S.authMode=el.dataset.m; render(); return; }
  if(a==='google'){ try{ await signInWithPopup(auth,new GoogleAuthProvider()); }catch(ex){ const er=$('#au-err'); if(er) er.textContent=authErr(ex); } return; }
  if(a==='logout'){ await signOut(auth); return; }
  if(a==='resend'){ try{ await sendEmailVerification(auth.currentUser); toast('驗證信已重新寄出'); }catch(ex){ toast(authErr(ex)); } return; }
  if(a==='verified'){ await auth.currentUser.reload(); if(auth.currentUser.emailVerified){ await auth.currentUser.getIdToken(true); onUser(auth.currentUser); } else toast('尚未完成驗證，請點擊信中的連結'); return; }
  if(a==='go-join'){ S.view='join'; location.hash='join'; render(); return; }
  if(a==='open-group'){ S.gid=el.dataset.g; lsSet('rc.gid',S.gid); S.view='app'; S.tab='overview'; location.hash='overview'; subscribeGroup(); render(); return; }
  if(a==='join'){
    const tg=S.groups.find(x=>x.id===el.dataset.g); const dn=$('#jn-name')?.value.trim();
    if(!dn){ toast('請先填寫你在小組中顯示的名字'); $('#jn-name')?.focus(); return; }
    return confirmModal('加入小組',`確定以「${esc(dn)}」的名字加入「${esc(tg.name)}」（#${esc(tg.code)}）？`,'加入',async()=>{
      if(await run(()=>joinGroup(tg,dn),`已加入「${tg.name}」`)){ S.gid=tg.id; lsSet('rc.gid',tg.id); S.view='app'; S.tab='overview'; location.hash='overview'; }
    });
  }
  if(a==='tab'){ S.tab=el.dataset.k; location.hash=S.tab; render(); return; }
  if(a==='see-att'){ S.attReport=el.dataset.r; S.tab='attendance'; location.hash='attendance'; render(); return; }
  if(a==='report-new') return reportModal();
  if(a==='report-edit') return reportModal(S.reports.find(r=>r.id===el.dataset.r));
  if(a==='report-del'){ const r=S.reports.find(x=>x.id===el.dataset.r); const n=(S.sessions[r.id]||[]).length;
    return confirmModal('刪除書報',`確定刪除「${esc(r.title)}」？${n?`這本書報的 <b>${n} 筆聚會出席紀錄也會一併刪除</b>，`:''}刪除後無法復原。`,'刪除書報與出席紀錄',async()=>{ await run(()=>deleteReport(r.id),'書報與出席紀錄已刪除'); }); }
  if(a==='session-new') return sessionModal(el.dataset.r,null);
  if(a==='session-edit') return sessionModal(el.dataset.r,el.dataset.d);
  if(a==='session-del'){ const rid=el.dataset.r, d=el.dataset.d; return confirmModal('刪除聚會紀錄',`確定刪除 ${fmtDate(d)} 的聚會與出席紀錄？`,'刪除',async()=>{ await run(()=>{ const b=writeBatch(db); b.delete(gRef('reports',rid,'sessions',d)); return b.commit(); },'已刪除'); }); }
  if(a==='toggle'){ el.disabled=true; await run(()=>toggleAttendance(el.dataset.r,el.dataset.d,el.dataset.u)); el.disabled=false; return; }
  if(a==='month'){ S.month=shiftMonth(S.month,+el.dataset.d); render(); return; }
  if(a==='export') return exportExcel();
  if(a==='g-save'){ const name=$('#gname').value.trim(); if(!name){ toast('請輸入小組名稱'); return; }
    await run(()=>setDoc(doc(db,'groups',g.id),{name,note:$('#gnote').value.trim(),updatedAt:Date.now()},{merge:true}),'小組資訊已儲存'); return; }
  if(a==='name-save'){ const n=$('#myname').value.trim(); if(!n){ toast('名字不能空白'); return; }
    const m=S.members[S.me]||{}; const ok=await run(()=>setDoc(doc(db,'groups',g.id,'members',S.me),{name:n,email:m.email||S.email,joinedAt:m.joinedAt||Date.now()}),'名字已更新');
    if(ok && isFounder(g)) await run(()=>setDoc(doc(db,'groups',g.id),{founderName:n,updatedAt:Date.now()},{merge:true}));
    return; }
  if(a==='m-remove'){ const u=el.dataset.u; return confirmModal('移出成員',`確定把「${esc(nameOf(u))}」移出小組？對方的出席紀錄會保留，但不再列入名單與報表。`,'移出',async()=>{ await run(()=>removeMember(g,u),'已移出成員'); }); }
  if(a==='g-leave') return confirmModal('退出小組',`確定退出「${esc(g.name)}」？之後可以再從「加入小組」重新加入。`,'退出',async()=>{ if(await run(()=>leaveGroup(g),'已退出小組')){ S.gid=null; S.subGid&&stopGroup(); } });
  if(a==='g-delete') return confirmModal('刪除小組',`確定刪除「${esc(g.name)}」（#${esc(g.code)}）及其所有書報、出席紀錄？此動作無法復原。`,'永久刪除',async()=>{ if(await run(()=>deleteGroup(g),'小組已刪除')){ S.gid=null; stopGroup(); } });
});
document.addEventListener('change',e=>{
  if(e.target.id==='gsel'){ S.gid=e.target.value; lsSet('rc.gid',S.gid); S.view='app'; if(location.hash==='#join') location.hash=S.tab; subscribeGroup(); render(); }
  if(e.target.id==='attr'){ S.attReport=e.target.value; render(); }
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&$('#modal-root').innerHTML) closeModal(); });
function readHash(){ const h=location.hash.slice(1); if(h==='join'){ S.view='join'; } else if(TABS.some(t=>t[0]===h)){ S.tab=h; S.view='app'; } }
window.addEventListener('hashchange',()=>{ readHash(); render(); });
readHash();

/* ============ init ============ */
function onUser(user){
  stopAll();
  S.authUser=user; S.me=user?user.uid:''; S.email=user?normEmail(user.email):'';
  S.authReady=true;
  if(user&&user.emailVerified){
    setDoc(doc(db,'users',user.uid),{email:S.email,name:user.displayName||'',lastLoginAt:Date.now()},{merge:true}).catch(()=>{});
    subscribeGroups();
  }
  render();
}
if(configured) onAuthStateChanged(auth,onUser);
render();
