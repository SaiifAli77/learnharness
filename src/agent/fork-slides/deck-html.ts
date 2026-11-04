/**
 * Fork-only: the downloadable deck.html, a self-contained file with every
 * frame (as image documents, so frame markup never runs) plus the
 * transcript and a simple stepper. Pure: frames are passed in.
 */
import type { ForkSlidesDeck } from "../../core/fork-slides.ts";

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Build deck.html from the deck and its frame SVGs (file name → svg). */
export function buildDeckHtml(title: string, deck: ForkSlidesDeck, frames: Record<string, string>): string {
	const steps: Array<{ slide: number; step: number; src: string }> = [];
	deck.slides.forEach((s, i) =>
		s.steps.forEach((st, j) => {
			const svg = frames[st.frame] ?? "";
			steps.push({ slide: i, step: j, src: `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}` });
		}),
	);
	const transcripts = deck.slides.map((s) => s.steps.map((st) => st.say));
	const data = JSON.stringify({ steps, transcripts }).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f6f6;color:#111}
main{max-width:1100px;margin:24px auto;padding:0 16px}
h1{font-size:18px;font-weight:600;margin:0 0 12px}
#frame{display:block;width:100%;height:auto;background:#fff;border:1px solid #ddd;border-radius:8px;cursor:pointer}
#say{margin:14px 0;line-height:1.6;color:#555}
#say .cur{color:#111;font-weight:600}
nav{display:flex;align-items:center;gap:12px}
button{font:inherit;padding:4px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
button:disabled{opacity:.4;cursor:default}
#count{font-variant-numeric:tabular-nums;color:#555}
details{margin-top:28px}
details p{line-height:1.6}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<img id="frame" alt="Slide frame">
<p id="say"></p>
<nav><button id="prev" type="button">&#9664; Prev</button><span id="count"></span><button id="next" type="button">Next &#9654;</button><span style="color:#888;font-size:13px">Click the picture or press Space for the next step; arrow keys move by slide.</span></nav>
<details><summary>Full transcript</summary>
${deck.slides.map((s, i) => `<p><strong>Slide ${i + 1}.</strong> ${escapeHtml(s.steps.map((st) => st.say).join(" "))}</p>`).join("\n")}
</details>
</main>
<script>
(function(){
var D=${data};
var i=0;
function slideStart(s){for(var k=0;k<D.steps.length;k++){if(D.steps[k].slide===s)return k}return 0}
function show(){
var st=D.steps[i];if(!st)return;
document.getElementById("frame").src=st.src;
var t=D.transcripts[st.slide],say=document.getElementById("say");say.textContent="";
for(var k=0;k<t.length;k++){var sp=document.createElement("span");sp.textContent=(k?" ":"")+t[k];if(k===st.step)sp.className="cur";say.appendChild(sp)}
document.getElementById("count").textContent=(st.slide+1)+" / "+D.transcripts.length;
document.getElementById("prev").disabled=st.slide===0;
document.getElementById("next").disabled=st.slide>=D.transcripts.length-1;
}
function slide(d){var s=Math.min(Math.max(D.steps[i].slide+d,0),D.transcripts.length-1);i=slideStart(s);show()}
function step(){if(i<D.steps.length-1){i++;show()}}
document.getElementById("prev").onclick=function(){slide(-1)};
document.getElementById("next").onclick=function(){slide(1)};
document.getElementById("frame").onclick=step;
document.addEventListener("keydown",function(e){
if(e.key==="ArrowRight"){slide(1);e.preventDefault()}
else if(e.key==="ArrowLeft"){slide(-1);e.preventDefault()}
else if(e.key===" "&&!(e.target&&e.target.tagName==="BUTTON")){step();e.preventDefault()}
});
show();
})();
</script>
</body>
</html>
`;
}
