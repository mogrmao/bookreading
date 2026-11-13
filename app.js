import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, sendEmailVerification, sendPasswordResetEmail, GoogleAuthProvider,
  signInWithPopup, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query, where
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
const fmtDateTime = d => `${d.getMonth()+1}/${d.getDate()}（${WD[d.getDay()]}）${pad(d.getHours())}:${pad(d.getMinutes())}`;
const monthKey = d => d.getFullYear()+'-'+pad(d.getMonth()+1);
const monthLabel = k => { const [y,m] = k.split('-'); return `${y} 年 ${Number(m)} 月`; };
const shiftMonth = (k,n) => { const [y,m] = k.split('-').map(Number); return monthKey(new Date(y,m-1+n,1)); };
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const pct = r => r==null ? '—' : Math.round(r*100)+'%';
const clone = o => JSON.parse(JSON.stringify(o));
const normEmail = e => String(e||'').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AV_COLORS = ['#2E7A69','#4E6FA0','#8A6BB0','#B07A3A','#3F8E9C','#A0565B','#5E8A3C','#6B7280'];
function avColor(id){ let h=0; for(const c of String(id)) h=(h*31+c.charCodeAt(0))>>>0; return AV_COLORS[h%AV_COLORS.length]; }
function avatar(m,sm){ const ch=(m.name||'?').trim().slice(0,1); return `<span class="avatar${sm?' sm':''}" style="background:${avColor(m.id)}" aria-hidden="true">${esc(ch)}</span>`; }
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
let toastT;
function toast(msg){ let t=$('.toast'); if(!t){ t=document.createElement('div'); t.className='toast'; t.setAttribute('role','status'); document.body.appendChild(t); } t.textContent=msg; clearTimeout(toastT); toastT=setTimeout(()=>t.remove(),3500); }
function fsErr(e){
  const c = e && e.code;
  if (c==='permission-denied') return '沒有權限：只有這個小組的組長可以修改。';
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
    'auth/unauthorized-domain':'這個網址尚未加入 Firebase 授權網域，請組長到 Authentication 設定中加入。'
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
const TABS = [['overview','書報進度'],['attendance','每週出席'],['monthly','參與報表'],['group','小組成員']];
const S = {
  authReady:false, authUser:null, email:'', authMode:'login',
  groups:[], gid:lsGet('rc.gid'), reports:[], sessions:[], loaded:false,
  tab:'overview', month:monthKey(new Date()), attFilter:'all',
  subGid:null, unsubG:null, unsubR:null, unsubS:null, draft:null
};

const curGroup = () => S.groups.find(g=>g.id===S.gid) || null;
const members = () => (curGroup()?.members) || [];
const leaders = g => (g?.members||[]).filter(m=>m.role==='leader');
const isLeader = () => { const g=curGroup(); return !!g && (g.leaderEmails||[]).includes(S.email); };
const myRecord = () => members().find(m=>m.id===S.email) || null;
const myName = () => myRecord()?.name || S.authUser?.displayName || S.email;
const byDate = (a,b) => (a.date||'').localeCompare(b.date||'') || (a.createdAt||0)-(b.createdAt||0);

/* ============ domain ============ */
function coverage(rid){ const set=new Set(); for(const s of S.sessions){ if(s.reportId!==rid) continue; const a=+s.fromPart||0, b=+s.toPart||a; for(let p=Math.min(a,b); p<=Math.max(a,b); p++) if(p>0) set.add(p); } return set; }
function nextPart(r){ const c=coverage(r.id); for(let p=1;p<=(+r.totalParts||0);p++) if(!c.has(p)) return p; return null; }
function nextMeeting(r){
  const sc=r.schedule; if(!sc||sc.weekday===''||sc.weekday==null) return null;
  const now=new Date(); const [hh,mm]=(sc.time||'20:00').split(':').map(Number);
  let base=now; if(r.startDate && parseYmd(r.startDate)>now) base=parseYmd(r.startDate);
  for(let i=0;i<8;i++){ const d=new Date(base.getFullYear(),base.getMonth(),base.getDate()+i,hh,mm); if(d.getDay()===Number(sc.weekday)&&d>now) return d; }
  return null;
}
function lastMeetingDate(r){
  const t=new Date(); if(!r||!r.schedule||r.schedule.weekday===''||r.schedule.weekday==null) return ymd(t);
  for(let i=0;i<7;i++){ const d=new Date(t.getFullYear(),t.getMonth(),t.getDate()-i); if(d.getDay()===Number(r.schedule.weekday)) return ymd(d); }
  return ymd(t);
}
function schedLabel(r){ const sc=r.schedule||{}; if(sc.weekday===''||sc.weekday==null) return '時間未定'; return `每週${WD[sc.weekday]} ${sc.time||''}`; }
function reportDone(r){ const t=+r.totalParts||0; return t>0 && coverage(r.id).size>=t; }
function status(rate){ if(rate==null) return ['neutral','—']; if(rate>=.8) return ['good','穩定參與']; if(rate>=.5) return ['warn','需關注']; return ['bad','待追蹤']; }
function presentCount(s){ const ids=new Set(members().map(m=>m.id)); return (s.present||[]).filter(id=>ids.has(id)).length; }
function partLabel(s){ return `${s.fromPart}${s.toPart&&s.toPart!=s.fromPart?'–'+s.toPart:''}`; }

function monthStats(mk){
  const ms=members();
  const sess=S.sessions.filter(s=>(s.date||'').startsWith(mk)).sort(byDate);
  const rows=ms.map(m=>{ let att=0; const seq=sess.map(s=>{ const p=(s.present||[]).includes(m.id); if(p) att++; return p; });
    let streak=0; for(let i=seq.length-1;i>=0&&!seq[i];i--) streak++;
    return {m,att,total:sess.length,rate:sess.length?att/sess.length:null,streak,seq}; });
  const avg=sess.length&&ms.length ? sess.reduce((a,s)=>a+presentCount(s)/ms.length,0)/sess.length : null;
  const full=sess.length ? rows.filter(r=>r.att===sess.length).length : 0;
  const follow=rows.filter(r=>r.rate!=null&&(r.rate<.5||r.streak>=2));
  return {sess,rows,avg,full,follow};
}

/* ============ data ============ */
function stopAll(){
  S.unsubG&&S.unsubG(); S.unsubR&&S.unsubR(); S.unsubS&&S.unsubS();
  S.unsubG=S.unsubR=S.unsubS=null; S.subGid=null; S.groups=[]; S.reports=[]; S.sessions=[]; S.loaded=false; S.draft=null;
}
function subscribeGroups(){
  const q=query(collection(db,'groups'), where('memberEmails','array-contains',S.email));
  S.unsubG=onSnapshot(q, snap=>{
    S.groups=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
    S.loaded=true;
    if(!S.groups.some(g=>g.id===S.gid)) S.gid=S.groups[0]?.id||null;
    subscribeGroup(); render();
  }, e=>{ S.loaded=true; render(); toast(fsErr(e)); });
}
function subscribeGroup(){
  const gid=S.gid; if(!gid||S.subGid===gid) return;
  S.unsubR&&S.unsubR(); S.unsubS&&S.unsubS();
  S.subGid=gid; S.reports=[]; S.sessions=[];
  S.unsubR=onSnapshot(collection(db,'groups',gid,'reports'), snap=>{
    S.reports=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)); render();
  }, e=>toast(fsErr(e)));
  S.unsubS=onSnapshot(collection(db,'groups',gid,'sessions'), snap=>{
    S.sessions=snap.docs.map(d=>({id:d.id,...d.data()})); render();
  }, e=>toast(fsErr(e)));
}
async function write(path,data){ try{ await setDoc(doc(db,path),data); return true; }catch(e){ toast(fsErr(e)); return false; } }
async function remove(path){ try{ await deleteDoc(doc(db,path)); return true; }catch(e){ toast(fsErr(e)); return false; } }

/* ============ auth views ============ */
function renderTop(){
  const tb=$('#topbar'); const brand=tb.querySelector('.brand').outerHTML;
  if(!S.authUser){ tb.innerHTML=brand; return; }
  let pick='';
  if(S.groups.length){
    pick=`<div class="group-pick"><label for="gsel">小組</label><select id="gsel">${S.groups.map(x=>`<option value="${esc(x.id)}"${x.id===S.gid?' selected':''}>${esc(x.name)}</option>`).join('')}</select>
    <button class="btn sm ghost" data-act="new-group">＋ 新小組</button></div>`;
  }
  const g=curGroup(); const lead=isLeader();
  const who=`<div class="me-chip"><span>${esc(myName())}</span>${g?`<span class="role-tag${lead?' lead':''}">${lead?'組長':'成員'}</span>`:''}<button class="btn sm ghost" data-act="logout">登出</button></div>`;
  tb.innerHTML=brand+'<div class="spacer"></div>'+pick+who;
}

function viewSetup(){
  return `<div class="card auth-card"><h2>尚未設定 Firebase</h2>
    <p class="muted">請把 Firebase 專案的設定值貼到 <code>public/firebase-config.js</code>，再重新部署。詳細步驟請見專案中的 README.md。</p></div>`;
}

function viewAuth(){
  const m=S.authMode;
  const title={login:'登入共讀書報',signup:'建立帳號',reset:'重設密碼'}[m];
  const sub={login:'使用組長登記的 Email 登入，即可查看你所屬小組的書報進度。',signup:'請使用組長登記在小組名單中的 Email 註冊。',reset:'輸入註冊的 Email，我們會寄送重設密碼連結。'}[m];
  return `<div class="auth-wrap"><div class="card auth-card">
    <h2>${title}</h2><p class="muted" style="margin:6px 0 18px">${sub}</p>
    <form id="authForm" class="grid" style="gap:12px" novalidate>
      ${m==='signup'?`<div class="field"><label for="au-name">姓名</label><input type="text" id="au-name" autocomplete="name" maxlength="20" required></div>`:''}
      <div class="field"><label for="au-email">Email</label><input type="email" id="au-email" autocomplete="email" required></div>
      ${m!=='reset'?`<div class="field"><label for="au-pw">密碼</label><input type="password" id="au-pw" autocomplete="${m==='signup'?'new-password':'current-password'}" minlength="6" required></div>`:''}
      <div class="err" id="au-err" role="alert"></div>
      <button class="btn primary" style="justify-content:center">${{login:'登入',signup:'註冊並寄送驗證信',reset:'寄送重設連結'}[m]}</button>
    </form>
    ${m!=='reset'?`<div class="divider"><span>或</span></div>
    <button class="btn" style="width:100%;justify-content:center" data-act="google">
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>
      使用 Google 帳號登入</button>`:''}
    <div class="auth-links">
      ${m==='login'?'<button class="btn ghost sm" data-act="auth-mode" data-m="signup">還沒有帳號？註冊</button><button class="btn ghost sm" data-act="auth-mode" data-m="reset">忘記密碼</button>':'<button class="btn ghost sm" data-act="auth-mode" data-m="login">返回登入</button>'}
    </div></div></div>`;
}

function viewVerify(){
  return `<div class="auth-wrap"><div class="card auth-card">
    <h2>請驗證你的 Email</h2>
    <p class="muted" style="margin:6px 0 16px">驗證信已寄到 <b>${esc(S.authUser.email)}</b>。點擊信中的連結後，回到這裡按「我已完成驗證」。沒收到的話，請檢查垃圾郵件匣。</p>
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
      render();
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
  if(!S.loaded){ app.innerHTML='<div class="empty"><p>正在載入小組資料…</p></div>'; return; }
  const g=curGroup();
  if(!g){
    app.innerHTML=`<div class="card empty"><h2>你目前還沒有加入任何小組</h2>
      <p>如果你是成員，請請組長把你的 Email（<b>${esc(S.email)}</b>）加入小組名單，加入後這裡會自動出現。</p>
      <p>如果你是組長，可以直接建立新的讀書小組。</p>
      <p class="mt"><button class="btn primary" data-act="new-group">建立小組</button></p></div>`;
    return;
  }
  const ls=leaders(g);
  const head=`<div class="ghead"><div style="flex:1;min-width:240px">
      <h1>${esc(g.name)}</h1>
      <div class="sub">${esc(g.note||'')}${g.note?' · ':''}<span class="num">${members().length}</span> 位成員</div></div>
      <div class="leaders">組長 ${ls.length?ls.map(m=>`<span class="pill neutral">${esc(m.name)}</span>`).join(''):'<span class="pill warn">尚未指定</span>'}</div></div>
    <nav class="tabs" role="tablist">${TABS.map(([k,l])=>`<button class="tab" role="tab" aria-selected="${S.tab===k}" data-act="tab" data-k="${k}">${l}</button>`).join('')}</nav>`;
  let body='';
  if(S.tab==='overview') body=viewOverview();
  else if(S.tab==='attendance') body=viewAttendance();
  else if(S.tab==='monthly') body=viewMonthly();
  else body=viewGroup();
  app.innerHTML=head+body;
  if(S.tab==='group') mountGroupEditor();
}

/* ---------- Overview ---------- */
function viewOverview(){
  const lead=isLeader(); const rs=S.reports;
  const st=monthStats(monthKey(new Date()));
  const upcoming=rs.filter(r=>!reportDone(r)).map(r=>nextMeeting(r)).filter(Boolean).sort((a,b)=>a-b)[0];
  const stats=`<div class="stats">
    <div class="card stat"><div class="k">進行中書報</div><div class="v">${rs.filter(r=>!reportDone(r)).length}<small>/ ${rs.length} 本</small></div></div>
    <div class="card stat"><div class="k">本月聚會</div><div class="v">${st.sess.length}<small>場</small></div></div>
    <div class="card stat"><div class="k">本月平均出席率</div><div class="v">${pct(st.avg)}</div></div>
    <div class="card stat"><div class="k">下次聚會</div><div class="v" style="font-size:18px;padding-top:6px">${upcoming?fmtDateTime(upcoming):'—'}</div></div></div>`;
  const cards = !rs.length
    ? `<div class="card empty"><h2 style="font-size:18px">還沒有書報</h2><p>${lead?'新增第一本書報，設定篇數與每週共讀時間。':'組長新增書報後，進度會顯示在這裡。'}</p>${lead?'<p><button class="btn primary" data-act="report-new">新增書報</button></p>':''}</div>`
    : `<div class="reports">${rs.map(reportCard).join('')}</div>`;
  const recent=[...S.sessions].sort(byDate).reverse().slice(0,6);
  const recentHtml=recent.length?`<ul class="list">${recent.map(s=>{ const r=rs.find(x=>x.id===s.reportId); const n=presentCount(s), t=members().length;
      return `<li><div class="grow"><div class="t">${fmtDate(s.date)}</div><div class="s">${esc(r?r.title:'（已刪除的書報）')} · 第 ${esc(partLabel(s))} 篇</div></div><span class="pill ${status(t?n/t:null)[0]} num">${n}/${t}</span></li>`; }).join('')}</ul>`:'<p class="muted" style="font-size:14px">尚無聚會紀錄。</p>';
  const memHtml=`<ul class="list">${members().map(m=>`<li>${avatar(m,true)}<div class="grow"><div class="t">${esc(m.name)}</div></div>${m.role==='leader'?'<span class="role-tag lead">組長</span>':''}</li>`).join('')}</ul>`;
  return stats+`<div class="grid cols-main">
    <section><div class="section-title"><h2>書報進度</h2><span class="hint">依聚會紀錄自動計算已讀篇數</span><div class="spacer"></div>${lead?'<button class="btn primary sm" data-act="report-new">＋ 新增書報</button>':''}</div>${cards}</section>
    <aside class="grid" style="align-content:start">
      <div class="card card-pad"><div class="section-title"><h2>最近聚會</h2><div class="spacer"></div>${lead&&rs.length?'<button class="btn sm" data-act="session-new">記錄出席</button>':''}</div>${recentHtml}</div>
      <div class="card card-pad"><div class="section-title"><h2>成員</h2><span class="hint num">${members().length} 位</span></div>${memHtml}</div>
    </aside></div>`;
}
function reportCard(r){
  const lead=isLeader(); const total=+r.totalParts||0; const cov=coverage(r.id); const done=Math.min(cov.size,total);
  const p=total?done/total:0; const np=nextPart(r); const nm=nextMeeting(r);
  const last=S.sessions.filter(s=>s.reportId===r.id).sort(byDate).pop();
  const partsViz=total<=60?`<div class="parts" aria-label="各篇完成狀態">${Array.from({length:total},(_,i)=>`<i class="${cov.has(i+1)?'done':''}" title="第 ${i+1} 篇${cov.has(i+1)?'（已讀）':''}"></i>`).join('')}</div>`:'';
  return `<article class="card rcard">
    <div><h3>${esc(r.title)}</h3>
    <div class="meta" style="margin-top:6px"><span>🗓 ${esc(schedLabel(r))}</span>${r.location?`<span>📍 ${esc(r.location)}</span>`:''}${r.startDate?`<span>自 ${fmtDate(r.startDate)} 起</span>`:''}</div></div>
    <div><div class="prog-row"><span><b>${done}</b> / ${total} 篇</span><span class="num">${Math.round(p*100)}%</span></div>
    <div class="bar" style="margin-top:6px"><i style="width:${(p*100).toFixed(1)}%"></i></div></div>
    ${partsViz}
    ${reportDone(r)?'<div class="next"><span>✔ 全部篇數已讀完</span></div>':`<div class="next"><span>下一篇：第 ${np??'—'} 篇</span><span>${nm?'下次聚會 '+fmtDateTime(nm):''}</span></div>`}
    ${r.note?`<div class="muted" style="font-size:13px">${esc(r.note)}</div>`:''}
    <div class="meta">最近聚會：${last?fmtDate(last.date):'尚無'}</div>
    ${lead?`<div class="foot"><button class="btn sm primary" data-act="session-new" data-r="${esc(r.id)}">記錄本週出席</button><button class="btn sm" data-act="report-edit" data-r="${esc(r.id)}">編輯</button></div>`:''}
  </article>`;
}

/* ---------- Attendance ---------- */
function viewAttendance(){
  const lead=isLeader(); const ms=members(); const rs=S.reports;
  let sess=[...S.sessions].sort(byDate);
  if(S.attFilter!=='all') sess=sess.filter(s=>s.reportId===S.attFilter);
  const cols=sess.slice(-12);
  const filter=`<select id="attf" style="width:auto" aria-label="篩選書報">${[['all','全部書報'],...rs.map(r=>[r.id,r.title])].map(([v,l])=>`<option value="${esc(v)}"${S.attFilter===v?' selected':''}>${esc(l)}</option>`).join('')}</select>`;
  const head=`<div class="section-title"><h2>出席紀錄表</h2><span class="hint">顯示最近 ${cols.length} 場${lead?'，點日期可修改':''}</span><div class="spacer"></div>${filter}${lead&&rs.length?'<button class="btn primary sm" data-act="session-new">＋ 記錄出席</button>':''}</div>`;
  if(!sess.length) return head+`<div class="card empty"><p>${rs.length?'尚無出席紀錄。':'請先在「書報進度」新增書報。'}</p></div>`;
  const matrix=`<div class="card tbl-wrap"><table class="matrix"><thead><tr><th class="sticky-col">成員</th>${cols.map(s=>{ const r=rs.find(x=>x.id===s.reportId);
      const lab=`${fmtDate(s.date)}<small>${esc(r?r.title.slice(0,6):'')} ${esc(partLabel(s))}</small>`;
      return `<th class="c">${lead?`<button data-act="session-edit" data-s="${esc(s.id)}" title="修改這場出席">${lab}</button>`:lab}</th>`; }).join('')}<th class="n">出席率</th></tr></thead>
    <tbody>${ms.map(m=>{ const att=cols.filter(s=>(s.present||[]).includes(m.id)).length; const rate=cols.length?att/cols.length:null;
      return `<tr><td class="sticky-col"><div style="display:flex;align-items:center;gap:8px">${avatar(m,true)}<span>${esc(m.name)}</span></div></td>${cols.map(s=>{ const on=(s.present||[]).includes(m.id); return `<td class="c"><span class="dot${on?' on':''}" role="img" aria-label="${on?'出席':'缺席'}"></span></td>`; }).join('')}<td class="n"><span class="pill ${status(rate)[0]}">${pct(rate)}</span></td></tr>`; }).join('')}
      <tr><td class="sticky-col muted">出席人數</td>${cols.map(s=>`<td class="c num muted">${presentCount(s)}/${ms.length}</td>`).join('')}<td></td></tr></tbody></table></div>`;
  const list=`<div class="section-title mt"><h2>聚會清單</h2></div><div class="card tbl-wrap"><table><thead><tr><th>日期</th><th>書報</th><th>篇次</th><th class="n">出席</th><th>備註</th>${lead?'<th></th>':''}</tr></thead><tbody>
    ${[...sess].reverse().map(s=>{ const r=rs.find(x=>x.id===s.reportId); return `<tr><td class="num">${esc(s.date)}</td><td>${esc(r?r.title:'（已刪除）')}</td><td class="num">${esc(partLabel(s))}</td><td class="n">${presentCount(s)}/${ms.length}</td><td class="muted">${esc(s.note||'')}</td>${lead?`<td class="n"><button class="btn sm ghost" data-act="session-edit" data-s="${esc(s.id)}">修改</button></td>`:''}</tr>`; }).join('')}
  </tbody></table></div>`;
  return head+matrix+list;
}

/* ---------- Monthly ---------- */
function viewMonthly(){
  const mk=S.month; const st=monthStats(mk);
  const nav=`<div class="monthnav"><button class="btn sm" data-act="month" data-d="-1" aria-label="上個月">‹</button><strong>${monthLabel(mk)}</strong><button class="btn sm" data-act="month" data-d="1" aria-label="下個月">›</button></div>`;
  const tools=`<div class="toolbar"><button class="btn primary" data-act="export">匯出 Excel</button></div>`;
  const kpi=`<div class="stats">
    <div class="card stat"><div class="k">聚會場次</div><div class="v">${st.sess.length}<small>場</small></div></div>
    <div class="card stat"><div class="k">平均出席率</div><div class="v">${pct(st.avg)}</div></div>
    <div class="card stat"><div class="k">全勤成員</div><div class="v">${st.full}<small>位</small></div></div>
    <div class="card stat${st.follow.length?' alert':''}"><div class="k">需追蹤成員</div><div class="v">${st.follow.length}<small>位</small></div></div></div>`;
  if(!st.sess.length) return `<div class="section-title">${nav}<div class="spacer"></div>${tools}</div>`+kpi+`<div class="card empty"><p>${monthLabel(mk)}沒有聚會紀錄。</p></div>`;
  const rows=[...st.rows].sort((a,b)=>(b.rate??-1)-(a.rate??-1)||a.m.name.localeCompare(b.m.name,'zh-Hant'));
  const table=`<div class="card tbl-wrap"><table><thead><tr><th>成員</th><th>角色</th><th class="n">出席 / 場次</th><th>出席率</th><th>狀態</th><th class="n">月底連續缺席</th></tr></thead><tbody>
    ${rows.map(r=>{ const [cls,lab]=status(r.rate); return `<tr><td><div style="display:flex;align-items:center;gap:8px">${avatar(r.m,true)}${esc(r.m.name)}</div></td><td>${r.m.role==='leader'?'<span class="role-tag lead">組長</span>':'<span class="role-tag">成員</span>'}</td>
      <td class="n">${r.att} / ${r.total}</td><td><div class="ratebar"><div class="bar"><i class="${cls==='good'?'':cls}" style="width:${((r.rate||0)*100).toFixed(0)}%"></i></div><span class="num" style="width:40px;text-align:right">${pct(r.rate)}</span></div></td>
      <td><span class="pill ${cls}">${lab}</span></td><td class="n">${r.streak>=2?`<span class="pill bad">${r.streak} 次</span>`:(r.streak||'—')}</td></tr>`; }).join('')}
  </tbody></table></div>`;
  const follow=st.follow.length?`<div class="card card-pad"><div class="section-title"><h2>建議追蹤</h2><span class="hint">出席率低於 50% 或月底連續缺席 2 次以上</span></div><ul class="list">${st.follow.map(r=>`<li>${avatar(r.m,true)}<div class="grow"><div class="t">${esc(r.m.name)}</div><div class="s">本月出席 ${r.att}/${r.total}（${pct(r.rate)}）${r.streak>=2?`，已連續缺席 ${r.streak} 次`:''}</div></div><span class="s">${esc(r.m.email)}</span></li>`).join('')}</ul></div>`
    :`<div class="card card-pad"><div class="section-title"><h2>建議追蹤</h2></div><p class="muted" style="font-size:14px">本月沒有需要追蹤的成員。</p></div>`;
  return `<div class="section-title">${nav}<div class="spacer"></div>${tools}</div>`+kpi+
    `<div class="grid cols-main" style="margin-bottom:16px"><div class="card card-pad chart"><div class="section-title"><h2>每場出席率</h2></div>${chartSvg(st.sess)}</div>${follow}</div>`+
    `<div class="section-title"><h2>成員參與明細</h2></div>`+table;
}
function chartSvg(sess){
  const n=sess.length, ms=members().length||1; const W=Math.max(620,n*64+48), H=210, L=40, T=16, B=36, ch=H-T-B, step=(W-L-8)/n, bw=Math.min(34,step*.55);
  let g=''; [0,.5,1].forEach(v=>{ const y=T+ch*(1-v); g+=`<line class="gl" x1="${L}" x2="${W-4}" y1="${y}" y2="${y}"/><text class="ax" x="${L-8}" y="${y+4}" text-anchor="end">${v*100}%</text>`; });
  sess.forEach((s,i)=>{ const r=presentCount(s)/ms; const h=Math.max(2,ch*r); const x=L+step*i+(step-bw)/2; const y=T+ch-h; const d=parseYmd(s.date);
    g+=`<rect class="b" x="${x}" y="${y}" width="${bw}" height="${h}" rx="4"><title>${esc(s.date)}：${presentCount(s)}/${ms}</title></rect><text class="bl" x="${x+bw/2}" y="${y-5}" text-anchor="middle">${Math.round(r*100)}%</text><text class="ax" x="${x+bw/2}" y="${H-14}" text-anchor="middle">${d.getMonth()+1}/${d.getDate()}</text>`; });
  return `<div class="tbl-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每場聚會出席率長條圖" style="min-width:${Math.min(W,520)}px;max-height:260px">${g}</svg></div>`;
}

/* ---------- Group / members ---------- */
function viewGroup(){
  const g=curGroup(); const lead=isLeader(); const ms=members();
  const help=`<div class="notice"><b>成員如何加入：</b>組長把成員的 Email 加到下方名單後，請成員用<b>同一個 Email</b>到本網站註冊（或用該 Google 帳號登入），登入後就會看到這個小組。</div>`;
  if(!lead){
    return `<div class="grid" style="max-width:760px"><div class="card card-pad"><div class="section-title"><h2>成員名單</h2><span class="hint num">${ms.length} 位</span></div><ul class="list">${ms.map(m=>`<li>${avatar(m)}<div class="grow"><div class="t">${esc(m.name)}${m.id===S.email?'（你）':''}</div><div class="s">${esc(m.email)}</div></div>${m.role==='leader'?'<span class="role-tag lead">組長</span>':'<span class="role-tag">成員</span>'}</li>`).join('')}</ul></div>${help}</div>`;
  }
  if(!S.draft||S.draft.gid!==g.id) S.draft={gid:g.id,name:g.name,note:g.note||'',members:clone(ms)};
  return `<div class="grid" style="max-width:900px">
    <div class="card card-pad"><div class="section-title"><h2>小組資訊</h2></div>
      <div class="row2"><div class="field"><label for="gname">小組名稱</label><input type="text" id="gname" maxlength="40"></div>
      <div class="field"><label for="gnote">簡介（選填）</label><input type="text" id="gnote" maxlength="80"></div></div></div>
    <div class="card card-pad"><div class="section-title"><h2>成員名單</h2><span class="counter" id="counter"></span><div class="spacer"></div><button class="btn sm" data-act="m-add">＋ 新增成員</button></div>
      <div class="tbl-wrap"><table class="roster"><thead><tr><th style="width:28%">姓名</th><th>Email（登入帳號）</th><th style="width:110px">角色</th><th style="width:44px"></th></tr></thead><tbody id="rosterBody"></tbody></table></div>
      <div class="err" id="rosterErr" role="alert"></div>
      <div class="toolbar mt"><button class="btn primary" data-act="g-save">儲存變更</button><button class="btn ghost" data-act="g-reset">還原</button></div></div>
    ${help}
    <div class="card card-pad"><div class="section-title"><h2>刪除小組</h2><span class="hint">會一併刪除這個小組的所有書報與出席紀錄，無法復原。</span><div class="spacer"></div><button class="btn danger" data-act="g-delete">刪除這個小組</button></div></div>
  </div>`;
}
function mountGroupEditor(){
  if(!isLeader()||!S.draft) return;
  const d=S.draft; $('#gname').value=d.name; $('#gnote').value=d.note;
  $('#gname').oninput=e=>d.name=e.target.value; $('#gnote').oninput=e=>d.note=e.target.value;
  renderRoster();
}
function renderRoster(){
  const d=S.draft; const tb=$('#rosterBody'); if(!tb) return;
  tb.innerHTML=d.members.map((m,i)=>`<tr data-i="${i}"><td><input type="text" id="mn-${i}" aria-label="姓名" value="${esc(m.name)}" data-f="name" maxlength="20"></td>
    <td><input type="email" id="me-${i}" aria-label="Email" value="${esc(m.email||'')}" data-f="email" placeholder="name@example.com"></td>
    <td><select id="mr-${i}" aria-label="角色" data-f="role"><option value="member"${m.role!=='leader'?' selected':''}>成員</option><option value="leader"${m.role==='leader'?' selected':''}>組長</option></select></td>
    <td><button class="x" type="button" data-act="m-del" data-i="${i}" aria-label="移除 ${esc(m.name)}">×</button></td></tr>`).join('');
  tb.querySelectorAll('[data-f]').forEach(el=>{ const ev=el.tagName==='SELECT'?'change':'input'; el.addEventListener(ev,()=>{ const i=+el.closest('tr').dataset.i; d.members[i][el.dataset.f]=el.value; updateCounter(); }); });
  updateCounter();
}
function cleanMembers(list){
  return list.filter(m=>(m.name||'').trim()||(m.email||'').trim()).map(m=>{ const email=normEmail(m.email); return {id:email,email,name:(m.name||'').trim(),role:m.role==='leader'?'leader':'member'}; });
}
function rosterErrors(ms){
  const e=[]; const lc=ms.filter(m=>m.role==='leader').length;
  if(ms.length<2) e.push('小組至少需要 2 位成員'); if(ms.length>30) e.push('小組最多 30 位成員');
  if(lc<1) e.push('至少需要 1 位組長'); if(lc>3) e.push('組長最多 3 位');
  const noName=ms.find(m=>!m.name); if(noName) e.push(`請填寫 ${noName.email||'每位成員'} 的姓名`);
  const bad=ms.find(m=>!EMAIL_RE.test(m.email)); if(bad) e.push(`「${bad.name||'某位成員'}」的 Email 未填或格式不正確`);
  const seen=new Set(); const dup=ms.find(m=>{ if(seen.has(m.email)) return true; seen.add(m.email); return false; }); if(dup) e.push(`Email ${dup.email} 重複了`);
  return e;
}
function groupPayload(base,name,note,ms){
  return {...base, name:name.trim(), note:(note||'').trim(), members:ms,
    memberEmails:ms.map(m=>m.email), leaderEmails:ms.filter(m=>m.role==='leader').map(m=>m.email), updatedAt:Date.now()};
}
function updateCounter(){
  const ms=S.draft.members.filter(m=>(m.name||'').trim()||(m.email||'').trim()); const lc=ms.filter(m=>m.role==='leader').length;
  const c=$('#counter'); if(c) c.innerHTML=`成員 <b class="num">${ms.length}</b> / 30 · 組長 <b class="num">${lc}</b> / 3`;
}

/* ============ modals ============ */
function openModal(title,body,foot,wide){
  const root=$('#modal-root');
  root.innerHTML=`<div class="overlay" data-act="ov"><div class="modal${wide?' wide':''}" role="dialog" aria-modal="true" aria-labelledby="mt"><header><h2 id="mt">${esc(title)}</h2><button class="x" type="button" data-act="close" aria-label="關閉">×</button></header><form id="mform" novalidate><div class="body">${body}</div><footer>${foot}</footer></form></div></div>`;
  const f=root.querySelector('input,select,textarea'); f&&f.focus();
  return $('#mform');
}
const closeModal=()=>{ $('#modal-root').innerHTML=''; };

function groupModal(){
  const f=openModal('建立新小組',`
    <div class="field"><label for="ng-name">小組名稱</label><input type="text" id="ng-name" maxlength="40" placeholder="例如：週三晚間讀書會"></div>
    <div class="field"><label for="ng-note">簡介（選填）</label><input type="text" id="ng-note" maxlength="80"></div>
    <div class="field"><label for="ng-mem">成員名單（每行一位：姓名, Email）</label><textarea id="ng-mem" rows="8" placeholder="王小明, ming@example.com&#10;林怡君, yijun@example.com"></textarea></div>
    <div class="field"><label for="ng-lead">其他組長的 Email（選填，以逗號分隔；你會自動成為組長）</label><input type="text" id="ng-lead" placeholder="yijun@example.com"></div>
    <div class="err" id="ng-err" role="alert"></div>`,
    `<button type="button" class="btn" data-act="close">取消</button><button class="btn primary">建立小組</button>`, true);
  $('#ng-mem').value=`${myName()}, ${S.email}\n`;
  f.onsubmit=async e=>{ e.preventDefault();
    const name=$('#ng-name').value.trim();
    const leadEmails=new Set([S.email,...$('#ng-lead').value.split(/[,，、\s]+/).map(normEmail).filter(Boolean)]);
    let ms=$('#ng-mem').value.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{ const parts=l.split(/[,，\t]/).map(s=>s.trim()); const em=parts.find(p=>p.includes('@'))||''; const nm=parts.find(p=>p&&!p.includes('@'))||''; return {name:nm,email:em,role:'member'}; });
    ms=cleanMembers(ms);
    if(!ms.some(m=>m.email===S.email)) ms.unshift({id:S.email,email:S.email,name:myName(),role:'leader'});
    ms.forEach(m=>{ if(leadEmails.has(m.email)) m.role='leader'; });
    const errs=[]; if(!name) errs.push('請輸入小組名稱'); errs.push(...rosterErrors(ms));
    const missing=[...leadEmails].filter(x=>!ms.some(m=>m.email===x)); if(missing.length) errs.push(`組長 ${missing.join('、')} 不在成員名單中`);
    if(errs.length){ $('#ng-err').textContent=errs.join('；'); return; }
    const gid='g'+uid();
    const data=groupPayload({createdBy:S.authUser.uid,createdAt:Date.now()},name,$('#ng-note').value,ms);
    if(await write('groups/'+gid,data)){ S.gid=gid; lsSet('rc.gid',gid); S.tab='overview'; closeModal(); toast('小組已建立'); }
  };
}

function reportModal(r){
  const isNew=!r; r=r||{title:'',totalParts:10,schedule:{weekday:3,time:'20:00'},startDate:ymd(new Date()),location:'',note:''};
  const f=openModal(isNew?'新增書報':'編輯書報',`
    <div class="field"><label for="rp-title">書報名稱</label><input type="text" id="rp-title" maxlength="60" value="${esc(r.title)}" placeholder="例如：《原子習慣》"></div>
    <div class="row3"><div class="field"><label for="rp-parts">書報篇數</label><input type="number" id="rp-parts" min="1" max="500" value="${esc(r.totalParts)}"></div>
      <div class="field"><label for="rp-wd">每週共讀日</label><select id="rp-wd">${WD.map((w,i)=>`<option value="${i}"${Number(r.schedule?.weekday)===i?' selected':''}>星期${w}</option>`).join('')}</select></div>
      <div class="field"><label for="rp-time">時間</label><input type="time" id="rp-time" value="${esc(r.schedule?.time||'20:00')}"></div></div>
    <div class="row2"><div class="field"><label for="rp-start">開始日期</label><input type="date" id="rp-start" value="${esc(r.startDate||'')}"></div>
      <div class="field"><label for="rp-loc">地點或會議連結（選填）</label><input type="text" id="rp-loc" maxlength="120" value="${esc(r.location||'')}"></div></div>
    <div class="field"><label for="rp-note">備註（選填）</label><textarea id="rp-note" rows="2" maxlength="300">${esc(r.note||'')}</textarea></div>
    <div class="err" id="rp-err" role="alert"></div>`,
    `${isNew?'':'<button type="button" class="btn danger" data-act="report-del" data-r="'+esc(r.id)+'" style="margin-right:auto">刪除書報</button>'}<button type="button" class="btn" data-act="close">取消</button><button class="btn primary">${isNew?'新增':'儲存'}</button>`);
  f.onsubmit=async e=>{ e.preventDefault();
    const title=$('#rp-title').value.trim(); const parts=parseInt($('#rp-parts').value,10);
    if(!title){ $('#rp-err').textContent='請輸入書報名稱'; return; }
    if(!(parts>=1&&parts<=500)){ $('#rp-err').textContent='書報篇數需介於 1–500'; return; }
    const id=r.id||'r'+uid();
    const data={title,totalParts:parts,schedule:{weekday:Number($('#rp-wd').value),time:$('#rp-time').value||'20:00'},startDate:$('#rp-start').value,location:$('#rp-loc').value.trim(),note:$('#rp-note').value.trim(),createdAt:r.createdAt||Date.now(),updatedAt:Date.now()};
    if(await write(`groups/${S.gid}/reports/${id}`,data)){ closeModal(); toast(isNew?'書報已新增':'已儲存'); }
  };
}

function sessionModal(s,presetReport){
  const rs=S.reports; if(!rs.length){ toast('請先新增書報'); return; }
  const isNew=!s; const ms=members();
  const r0=rs.find(x=>x.id===(s?.reportId||presetReport))||rs.find(x=>!reportDone(x))||rs[0];
  const np=nextPart(r0)||1;
  s=s||{date:lastMeetingDate(r0),reportId:r0.id,fromPart:np,toPart:np,present:[],note:''};
  const f=openModal(isNew?'記錄每週出席':'修改出席紀錄',`
    <div class="row2"><div class="field"><label for="ss-r">書報</label><select id="ss-r">${rs.map(r=>`<option value="${esc(r.id)}"${r.id===s.reportId?' selected':''}>${esc(r.title)}</option>`).join('')}</select></div>
      <div class="field"><label for="ss-date">聚會日期</label><input type="date" id="ss-date" value="${esc(s.date)}"></div></div>
    <div class="row2"><div class="field"><label for="ss-from">本次共讀：從第幾篇</label><input type="number" id="ss-from" min="1" value="${esc(s.fromPart)}"></div>
      <div class="field"><label for="ss-to">到第幾篇</label><input type="number" id="ss-to" min="1" value="${esc(s.toPart)}"></div></div>
    <div class="field"><div class="lbl" style="display:flex;justify-content:space-between;align-items:center">參與成員 <span><span id="ss-cnt" class="num"></span> <button type="button" class="btn sm ghost" id="ss-all">全選</button><button type="button" class="btn sm ghost" id="ss-none">清除</button></span></div>
      <div class="checks">${ms.map((m,i)=>`<label class="check"><input type="checkbox" id="ck-${i}" value="${esc(m.id)}"${(s.present||[]).includes(m.id)?' checked':''}>${esc(m.name)}</label>`).join('')}</div></div>
    <div class="field"><label for="ss-note">備註（選填）</label><input type="text" id="ss-note" maxlength="200" value="${esc(s.note||'')}" placeholder="例如：由林怡君導讀"></div>
    <div class="err" id="ss-err" role="alert"></div>`,
    `${isNew?'':'<button type="button" class="btn danger" data-act="session-del" data-s="'+esc(s.id)+'" style="margin-right:auto">刪除</button>'}<button type="button" class="btn" data-act="close">取消</button><button class="btn primary">儲存</button>`, true);
  const boxes=()=>[...f.querySelectorAll('.checks input')];
  const cnt=()=>$('#ss-cnt').textContent=`${boxes().filter(b=>b.checked).length} / ${ms.length} 位`;
  boxes().forEach(b=>b.onchange=cnt); cnt();
  $('#ss-all').onclick=()=>{ boxes().forEach(b=>b.checked=true); cnt(); };
  $('#ss-none').onclick=()=>{ boxes().forEach(b=>b.checked=false); cnt(); };
  $('#ss-r').onchange=()=>{ if(!isNew) return; const r=rs.find(x=>x.id===$('#ss-r').value); const p=nextPart(r)||1; $('#ss-from').value=p; $('#ss-to').value=p; $('#ss-date').value=lastMeetingDate(r); };
  f.onsubmit=async e=>{ e.preventDefault();
    const r=rs.find(x=>x.id===$('#ss-r').value); const a=parseInt($('#ss-from').value,10), b=parseInt($('#ss-to').value,10)||a;
    const date=$('#ss-date').value;
    if(!date){ $('#ss-err').textContent='請選擇聚會日期'; return; }
    if(!(a>=1)||b<a||b>(+r.totalParts||0)){ $('#ss-err').textContent=`篇次需介於 1–${r.totalParts}，且「到」不可小於「從」`; return; }
    const id=s.id||'s'+uid();
    const data={date,reportId:r.id,fromPart:a,toPart:b,present:boxes().filter(x=>x.checked).map(x=>x.value),note:$('#ss-note').value.trim(),createdAt:s.createdAt||Date.now(),updatedAt:Date.now(),recordedBy:S.email};
    if(await write(`groups/${S.gid}/sessions/${id}`,data)){ closeModal(); toast('出席紀錄已儲存'); }
  };
}

function confirmModal(title,msg,okLabel,onOk){
  const f=openModal(title,`<p style="margin:0">${msg}</p>`,`<button type="button" class="btn" data-act="close">取消</button><button class="btn danger" style="background:var(--bad);color:#fff;border-color:var(--bad)">${esc(okLabel)}</button>`);
  f.onsubmit=async e=>{ e.preventDefault(); f.querySelector('button.danger').disabled=true; await onOk(); closeModal(); };
}

/* ---------- Excel export ---------- */
function exportExcel(){
  if(!window.XLSX){ toast('Excel 元件尚未載入，請稍後再試'); return; }
  const g=curGroup(); const mk=S.month; const st=monthStats(mk); const ms=members(); const rs=S.reports;
  const title=r=>r?r.title:'（已刪除）';
  const sum=[[`${g.name}｜${monthLabel(mk)} 參與報表`],[],['聚會場次',st.sess.length],['平均出席率',st.avg==null?'':Math.round(st.avg*1000)/10+'%'],['全勤成員',st.full],['需追蹤成員',st.follow.length],[],
    ['成員','角色','Email','出席','場次','出席率','狀態','月底連續缺席']];
  st.rows.forEach(r=>sum.push([r.m.name,r.m.role==='leader'?'組長':'成員',r.m.email||'',r.att,r.total,r.rate==null?'':Math.round(r.rate*1000)/10+'%',status(r.rate)[1],r.streak]));
  const det=[['成員',...st.sess.map(s=>`${s.date} ${title(rs.find(x=>x.id===s.reportId))} 第${partLabel(s)}篇`),'出席次數']];
  ms.forEach(m=>{ let c=0; det.push([m.name,...st.sess.map(s=>{ const p=(s.present||[]).includes(m.id); if(p) c++; return p?'✓':'✗'; }),c]); });
  const prog=[['書報名稱','總篇數','已讀篇數','完成度','共讀時間','開始日期','地點']];
  rs.forEach(r=>{ const t=+r.totalParts||0, d=Math.min(coverage(r.id).size,t); prog.push([r.title,t,d,t?Math.round(d/t*100)+'%':'',schedLabel(r),r.startDate||'',r.location||'']); });
  const all=[['日期','書報','篇次','出席人數','成員總數','出席成員','缺席成員','備註']];
  [...S.sessions].sort(byDate).forEach(s=>{ const p=ms.filter(m=>(s.present||[]).includes(m.id)); const a=ms.filter(m=>!(s.present||[]).includes(m.id));
    all.push([s.date,title(rs.find(x=>x.id===s.reportId)),partLabel(s),p.length,ms.length,p.map(m=>m.name).join('、'),a.map(m=>m.name).join('、'),s.note||'']); });
  const wb=XLSX.utils.book_new();
  const add=(rows,name,widths)=>{ const ws=XLSX.utils.aoa_to_sheet(rows); ws['!cols']=widths.map(w=>({wch:w})); XLSX.utils.book_append_sheet(wb,ws,name); };
  add(sum,'月報摘要',[16,8,26,8,8,10,10,14]);
  add(det,'本月出席明細',[14,...st.sess.map(()=>22),10]);
  add(prog,'書報進度',[28,8,10,10,16,12,20]);
  add(all,'全部出席紀錄',[12,24,8,10,10,40,30,24]);
  XLSX.writeFile(wb,`${g.name}_${mk}_參與報表.xlsx`);
}

/* ============ events ============ */
document.addEventListener('click',async e=>{
  const el=e.target.closest('[data-act]'); if(!el) return; const a=el.dataset.act;
  if(a==='ov'){ if(e.target===el) closeModal(); return; }
  if(a==='close'){ closeModal(); return; }
  if(a==='auth-mode'){ S.authMode=el.dataset.m; render(); return; }
  if(a==='google'){ try{ await signInWithPopup(auth,new GoogleAuthProvider()); }catch(ex){ const er=$('#au-err'); if(er) er.textContent=authErr(ex); } return; }
  if(a==='logout'){ await signOut(auth); return; }
  if(a==='resend'){ try{ await sendEmailVerification(auth.currentUser); toast('驗證信已重新寄出'); }catch(ex){ toast(authErr(ex)); } return; }
  if(a==='verified'){ await auth.currentUser.reload(); if(auth.currentUser.emailVerified){ await auth.currentUser.getIdToken(true); onUser(auth.currentUser); } else toast('尚未完成驗證，請點擊信中的連結'); return; }
  if(a==='tab'){ S.tab=el.dataset.k; location.hash=S.tab; render(); return; }
  if(a==='new-group') return groupModal();
  if(a==='report-new') return reportModal();
  if(a==='report-edit') return reportModal(S.reports.find(r=>r.id===el.dataset.r));
  if(a==='report-del'){ const r=S.reports.find(x=>x.id===el.dataset.r); const n=S.sessions.filter(s=>s.reportId===r.id).length;
    return confirmModal('刪除書報',`確定刪除「${esc(r.title)}」？${n?`相關的 ${n} 筆出席紀錄會保留，但不再計入進度。`:''}`,'刪除',async()=>{ if(await remove(`groups/${S.gid}/reports/${r.id}`)) toast('書報已刪除'); }); }
  if(a==='session-new') return sessionModal(null,el.dataset.r);
  if(a==='session-edit') return sessionModal(clone(S.sessions.find(s=>s.id===el.dataset.s)));
  if(a==='session-del'){ const id=el.dataset.s; return confirmModal('刪除出席紀錄','確定刪除這筆出席紀錄？','刪除',async()=>{ if(await remove(`groups/${S.gid}/sessions/${id}`)) toast('已刪除'); }); }
  if(a==='month'){ S.month=shiftMonth(S.month,+el.dataset.d); render(); return; }
  if(a==='export') return exportExcel();
  if(a==='m-add'){ S.draft.members.push({id:'',name:'',email:'',role:'member'}); renderRoster(); const ins=document.querySelectorAll('#rosterBody input[data-f=name]'); ins[ins.length-1]?.focus(); return; }
  if(a==='m-del'){ S.draft.members.splice(+el.dataset.i,1); renderRoster(); return; }
  if(a==='g-reset'){ S.draft=null; render(); return; }
  if(a==='g-save'){ const d=S.draft; const ms=cleanMembers(d.members);
    const errs=rosterErrors(ms); if(!d.name.trim()) errs.unshift('請輸入小組名稱');
    $('#rosterErr').textContent=errs.join('；'); if(errs.length) return;
    const g=curGroup(); const base=clone(g); delete base.id;
    el.disabled=true;
    if(await write('groups/'+g.id,groupPayload(base,d.name,d.note,ms))){ S.draft=null; toast('小組資料已儲存'); }
    el.disabled=false; return; }
  if(a==='g-delete'){ const g=curGroup(); return confirmModal('刪除小組',`確定刪除「${esc(g.name)}」及其所有書報、出席紀錄？此動作無法復原。`,'永久刪除',async()=>{
    for(const s of [...S.sessions]) await remove(`groups/${g.id}/sessions/${s.id}`);
    for(const r of [...S.reports]) await remove(`groups/${g.id}/reports/${r.id}`);
    if(await remove('groups/'+g.id)){ S.gid=null; S.subGid=null; toast('小組已刪除'); } }); }
});
document.addEventListener('change',e=>{
  if(e.target.id==='gsel'){ S.gid=e.target.value; lsSet('rc.gid',S.gid); S.draft=null; S.attFilter='all'; subscribeGroup(); render(); }
  if(e.target.id==='attf'){ S.attFilter=e.target.value; render(); }
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&$('#modal-root').innerHTML) closeModal(); });
function readHash(){ const h=location.hash.slice(1); if(TABS.some(t=>t[0]===h)) S.tab=h; }
window.addEventListener('hashchange',()=>{ readHash(); render(); });
readHash();

/* ============ init ============ */
function onUser(user){
  stopAll();
  S.authUser=user; S.email=user?normEmail(user.email):'';
  S.authReady=true;
  if(user&&user.emailVerified){
    setDoc(doc(db,'users',user.uid),{email:S.email,name:user.displayName||'',lastLoginAt:Date.now()},{merge:true}).catch(()=>{});
    subscribeGroups();
  }
  render();
}
if(configured) onAuthStateChanged(auth,onUser);
render();
