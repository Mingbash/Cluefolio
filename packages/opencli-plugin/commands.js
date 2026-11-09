import { cli, Strategy } from "@jackwener/opencli/registry";
import fs from "node:fs";
import path from "node:path";
const snapshot = String.raw`(() => {
 const unref=x=>x?._value??x?.value??x;
 const state=window.__INITIAL_STATE__||{};
 const text=document.body?.innerText||'';
 const blocked=/安全限制|访问链接异常|请完成验证|滑动验证|安全验证|拖动箭头/.test(text)||/error_code=300017|error_code=300031|website-login\/captcha/.test(location.href);
 const login=location.pathname.startsWith('/login');
 const user=state.user||{};
 const groups=unref(user.notes)||[];
 const notes=Array.isArray(groups)?groups.flat().filter(Boolean):[];
 const data=unref(user.userPageData)||{};
 const normalize=e=>{const n=e.noteCard||e.note_card||e;const i=n.interactInfo||n.interact_info||{};return {id:n.noteId||n.note_id||e.id||e.noteId,title:n.displayTitle||n.title||'',author:n.user?.nickname||data.basicInfo?.nickname||'',authorId:n.user?.userId||n.user?.user_id||'',type:n.type,cover:n.cover?.urlDefault||n.cover?.urlPre||n.cover?.url||null,likes:i.likedCount??i.liked_count??null,collects:i.collectedCount??i.collected_count??null,publishedAt:n.time||null,xsecToken:e.xsecToken||e.xsec_token||n.xsecToken||n.xsec_token||''};};
 const endElements=[...document.querySelectorAll('.end-container,.end-text,.no-more,.no-more-text')];
 const ended=endElements.some(e=>e.getBoundingClientRect().height>0&&/没有更多|到底了|THE END/i.test(e.textContent||''));
 const map=state.note?.noteDetailMap||{};
 const id=(location.pathname.match(/(?:explore|item|profile\/[a-f0-9]+)\/([a-f0-9]{24})/)||[])[1];
 const detail=map[id]?.note||map[id]||null;
 const subtitles=[...document.querySelectorAll('video track')].map(t=>{let cues=[];try{cues=[...(t.track?.cues||[])].map(c=>({start:c.startTime,end:c.endTime,text:c.text||''}));}catch{}return {language:t.srclang||'',url:t.src||undefined,cues};});
 return {blocked,login,subtitles,notes:notes.map(normalize),ended,userId:data.basicInfo?.userId||'',userName:data.basicInfo?.nickname||'',detail:detail?JSON.parse(JSON.stringify(detail)):null,pageUrl:location.href,bodyText:document.querySelector('#detail-desc')?.innerText??null,domTitle:document.querySelector('#detail-title')?.textContent??'',domAuthor:document.querySelector('.author-wrapper .name,.username')?.textContent??'',metrics:{likes:document.querySelector('.interact-container .like-wrapper .count')?.textContent??null,collects:document.querySelector('.interact-container .collect-wrapper .count')?.textContent??null},statePresent:!!state.user,debug:{path:location.pathname,id,mapKeys:Object.keys(map),title:document.title,text:text.slice(0,350)}};
})()`;
function check(s) {
  if (s.blocked)
    throw new Error("SECURITY_BLOCK: 访问受限，请稍后在浏览器确认");
  if (s.login) throw new Error("AUTH_REQUIRED: 请在 Chrome 登录小红书");
}
function signed(input, profile = false) {
  const u = new URL(input);
  if (
    !["www.xiaohongshu.com", "xiaohongshu.com", "xhslink.com"].includes(
      u.hostname,
    )
  )
    throw new Error("INVALID_URL");
  if (profile && !/\/user\/profile\/[a-f0-9]{24}/.test(u.pathname))
    throw new Error("INVALID_PROFILE");
  return u.href;
}
cli({
  site: "xhs-distiller",
  name: "detail",
  description: "Read structured note and canonical ordered media",
  access: "read",
  strategy: Strategy.COOKIE,
  browser: true,
  domain: "www.xiaohongshu.com",
  navigateBefore: false,
  args: [{ name: "url", positional: true, required: true }],
  columns: ["data"],
  func: async (page, k) => {
    await page.goto(signed(k.url));
    let s;
    for (let i = 0; i < 5; i++) {
      await page.wait(2);
      s = await page.evaluate(snapshot);
      check(s);
      if (s.detail) break;
    }
    if (!s.detail)
      throw new Error("CONTENT_MISSING: " + JSON.stringify(s.debug));
    return [{ data: s }];
  },
});
cli({
  site: "xhs-distiller",
  name: "scan",
  description: "Enumerate public author notes with explicit completion",
  access: "read",
  strategy: Strategy.COOKIE,
  browser: true,
  domain: "www.xiaohongshu.com",
  navigateBefore: false,
  args: [
    { name: "url", positional: true, required: true },
    { name: "output", required: true },
    { name: "max-scrolls", type: "int", default: 1000 },
  ],
  columns: ["complete", "count", "reason"],
  func: async (page, k) => {
    const file = path.resolve(k.output);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.goto(signed(k.url, true));
    const seen = new Map();
    let stalled = 0,
      complete = false,
      reason = "";
    for (let i = 0; i < Number(k["max-scrolls"]); i++) {
      await page.wait(3);
      const s = await page.evaluate(snapshot);
      check(s);
      const prev = seen.size;
      for (const n of s.notes) if (n.id) seen.set(n.id, n);
      complete = s.ended;
      stalled = seen.size === prev ? stalled + 1 : 0;
      const batch = {
        notes: [...seen.values()],
        complete,
        iterations: i + 1,
        author: s.userName,
      };
      fs.writeFileSync(file + ".tmp", JSON.stringify(batch), { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
      if (complete) break;
      if (stalled >= 5) {
        reason = "列表连续无增长，尚未观察到结束标记，可恢复重试";
        break;
      }
      await page.autoScroll({ times: 1, delayMs: 1500 });
    }
    if (!complete && !reason) reason = "达到单次滚动保护上限，可继续加载";
    return [{ complete, count: seen.size, reason }];
  },
});
