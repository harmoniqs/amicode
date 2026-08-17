import * as vscode from "vscode";
import { registerInspectorPoster, type InspectorBridgeMessage } from "./inspector_bridge";

// ============================================================================
// Sidebar Run Inspector — the Work Column inspector relocated under the
// context tree (amicode# — user request). A VS Code WebviewView inside the
// `amicode` container, so it stacks vertically under Armonia + Catalog with
// no extra activity-bar entry. It reuses the existing inspector_bridge fan-out:
// RunsManager already broadcasts run:iteration / run:pulse / run:completion
// via registerInspectorPoster; this view registers its own poster and renders
// a lightweight pulse + fidelity view at sidebar width (320px). The Work Column
// tab can remain for detailed plots; this is the always-visible summary.
// ============================================================================

export class RunInspectorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "amicode.runInspector";
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private lastMsg?: InspectorBridgeMessage;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.ctx.extensionUri],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    // Register as an inspector poster so run: events land here too.
    // The Work Column app also listens; both surfaces stay in sync.
    const poster = registerInspectorPoster((msg) => {
      const envelope = msg as InspectorBridgeMessage & { source?: string };
      // Only forward our typed inspector messages
      if (envelope && typeof (envelope as { type?: string }).type === "string" && String((envelope as { type: string }).type).startsWith("run:")) {
        this.lastMsg = envelope as InspectorBridgeMessage;
        void webviewView.webview.postMessage(envelope);
      }
    });
    this.disposables.push(poster);
    webviewView.onDidDispose(() => {
      poster.dispose();
      this.disposables.forEach((d) => d.dispose());
      this.disposables = [];
      if (this.view === webviewView) this.view = undefined;
    });
    // Handle messages from the webview (e.g., selectRun)
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "selectRun" && typeof msg.runId === "string") {
        void vscode.commands.executeCommand("amicode.selectRun");
      }
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      "img-src data: https:",
      "connect-src 'self'",
    ].join("; ");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body { margin:0; padding:0; background: var(--vscode-sideBar-background); color: var(--vscode-sideBar-foreground); font: 12px var(--vscode-font-family, sans-serif); }
    .wrap { padding: 10px 10px 12px; display:flex; flex-direction:column; gap:10px; }
    .eyebrow { font-size:10px; letter-spacing:.08em; text-transform:uppercase; color: var(--vscode-descriptionForeground); }
    .card { border:1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); border-radius:8px; background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background)); overflow:hidden; }
    .card-hd { padding:8px 10px; border-bottom:1px solid var(--vscode-panel-border); display:flex; align-items:center; justify-content:space-between; }
    .card-hd b { font-size:12px; }
    .card-bd { padding:10px; }
    .row { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
    .mono { font-family: var(--vscode-editor-font-family, monospace); font-size:11px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .spark { height:28px; width:100%; display:block; background: var(--vscode-editor-background); border-radius:4px; border:1px solid var(--vscode-panel-border); }
    .btn { border:1px solid var(--vscode-button-border, transparent); border-radius:6px; padding:4px 8px; font-size:11px; cursor:pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-ghost { background: transparent; color: var(--vscode-sideBar-foreground); border-color: var(--vscode-panel-border); }
    .kv { display:grid; grid-template-columns: 1fr auto; gap:4px 12px; font-size:11px; }
    .kv dt { color: var(--vscode-descriptionForeground); }
    .kv dd { margin:0; font-variant-numeric: tabular-nums; }
    .empty { padding:18px 10px; text-align:center; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="eyebrow">Run Inspector — sidebar</div>
    <div id="empty" class="card"><div class="empty">No live run — start a solve to see iterations here.<br/><span class="muted">Live pulse streams to both the sidebar and Work Column.</span></div></div>
    <div id="live" class="card" style="display:none">
      <div class="card-hd"><b id="title">Run</b><span id="status" class="mono muted">live</span></div>
      <div class="card-bd" style="display:flex; flex-direction:column; gap:8px">
        <canvas id="spark" class="spark" width="300" height="28"></canvas>
        <div class="kv">
          <dt>Iteration</dt><dd id="iter" class="mono">—</dd>
          <dt>Objective</dt><dd id="obj" class="mono">—</dd>
          <dt>Fidelity</dt><dd id="fid" class="mono">—</dd>
        </div>
        <div class="row"><button class="btn btn-ghost" id="openBtn">Open in Work Column</button><span class="muted" style="font-size:11px">Under Armonia · Catalog</span></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    (function(){
      const vs = acquireVsCodeApi();
      const empty = document.getElementById('empty');
      const live = document.getElementById('live');
      const title = document.getElementById('title');
      const status = document.getElementById('status');
      const iterEl = document.getElementById('iter');
      const objEl = document.getElementById('obj');
      const fidEl = document.getElementById('fid');
      const canvas = document.getElementById('spark');
      const ctx = canvas.getContext('2d');
      let points = [];
      let runId = null;
      function showLive(){ empty.style.display='none'; live.style.display=''; }
      function draw(){
        if(!ctx) return;
        const dpr = window.devicePixelRatio||1;
        const w = canvas.clientWidth*dpr, h = canvas.clientHeight*dpr;
        canvas.width=w; canvas.height=h;
        ctx.clearRect(0,0,w,h);
        if(points.length<2) return;
        const min=Math.min(...points), max=Math.max(...points);
        const pad=4*dpr;
        ctx.beginPath();
        points.forEach((v,i)=>{
          const x = pad + (i/(Math.max(1,points.length-1)))*(w-2*pad);
          const y = h-pad - ((v-min)/Math.max(1e-9,max-min))*(h-2*pad);
          if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        });
        ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-orange')||'#e67e22';
        ctx.lineWidth=1.5*dpr; ctx.stroke();
      }
      window.addEventListener('message', e=>{
        const m=e.data;
        if(!m||typeof m.type!=='string' || !m.type.startsWith('run:')) return;
        if(m.type==='run:activate' || m.type==='run:label'){ runId=m.runId; title.textContent=m.runId.slice(0,10); showLive(); }
        if(m.type==='run:iteration'){ points.push(m.objective); if(points.length>120) points.shift(); iterEl.textContent=String(m.iter); objEl.textContent=m.objective.toExponential(2); showLive(); draw(); }
        if(m.type==='run:completion'){ status.textContent=m.status; fidEl.textContent=(1-m.fidelity).toExponential(2)+' infidelity'; showLive(); }
      });
      document.getElementById('openBtn').addEventListener('click', ()=> vs.postMessage({type:'selectRun', runId}));
      // Keep spark crisp on resize
      new ResizeObserver(draw).observe(canvas);
    })();
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
