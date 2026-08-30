# Ed (edstem) API — Authoring Assignments

Reverse-engineered notes for creating and editing Ed course content (modules, lessons, slides, quizzes, code challenges) over Ed's REST API. Everything here was verified against the live API while building the AI 611 master course (course `104656`).

The intended way to run these calls is from the **browser DevTools console (or an injected script) while logged into Ed** — that gives you a valid session token and the right origin. There is no public/documented API; this is what the Ed web client itself does.

---

## Auth & basics

- **Base URL:** `https://us.edstem.org/api`
- **Auth header:** `x-token: <JWT>` — *not* `Authorization: Bearer`. Grab the token from any request the web app makes (its `x-token` request header). It's session-scoped and expires; never commit it.
- **Credentials:** call with `credentials: 'omit'`. The page origin (`edstem.org`) differs from the API origin (`us.edstem.org`), so `credentials: 'include'` fails CORS. Auth is entirely via the `x-token` header.
- File uploads for code challenges go to a second host, `https://sahara.us.edstem.org`.

### THE gotcha: slide writes are multipart, everything else is JSON

This cost hours. **Creating or updating a slide must be sent as `multipart/form-data` with a single form field named `slide`** whose value is the JSON string. Sending `application/json` returns `400 {"message":"Missing slide"}`.

Everything else — modules, lessons, quiz questions, challenges — uses plain `application/json`.

```js
// helper for slide writes
const slideForm = (obj) => { const fd = new FormData(); fd.append('slide', JSON.stringify(obj)); return fd; };
```

---

## Endpoints by resource

Conventions below: `JH = {'content-type':'application/json','x-token':TOKEN}`; `TH = {'x-token':TOKEN}` (no content-type, so the browser sets the multipart boundary itself).

### Modules
| Action | Method / path | Body | Notes |
|---|---|---|---|
| Create | `POST /courses/{courseId}/lessons/modules` | JSON `{module:{course_id, name, index}}` | → 201, returns `{module:{id}}` |
| Delete | `DELETE /lessons/modules/{moduleId}` | — | → 204 |

### Lessons
| Action | Method / path | Body | Notes |
|---|---|---|---|
| Create | `POST /courses/{courseId}/lessons` | JSON `{lesson:{type:'general', kind:'attempt', is_hidden:true}}` | → 201, returns `{lesson:{id}}`. **`title` is ignored on create** — set it with an update. |
| Update | `PUT /lessons/{lessonId}` | JSON `{lesson:{…full object, minus `slides`…}}` | → 200. Use for `title`, `module_id`, `index`. **`PATCH` returns 404.** |
| Delete | `DELETE /lessons/{lessonId}` | — | → 204 |
| Get | `GET /lessons/{lessonId}` | — | Returns `{lesson:{…, slides:[…]}}`. ⚠️ embeds code-slide tickets/JWTs — see "Filtered output" below. |

Lesson "kind": `attempt` = a submission/assessment lesson (what HW and project assignments are). `type: 'general'`.

### Slides
| Action | Method / path | Body | Notes |
|---|---|---|---|
| Create | `POST /lessons/{lessonId}/slides` | **multipart** field `slide` = JSON `{type:'quiz', is_survey:false}` / `{type:'code'}` / `{type:'document'}` | → 201, returns `{slide:{id, challenge_id, …}}`. A `code` slide gets its `challenge_id` immediately. |
| Update | `PUT /lessons/slides/{slideId}` | **multipart** field `slide` = full slide JSON | → 200. GET the slide, merge your changes, PUT it back. Sets `title`, `auto_points`, `index`, `is_hidden`, … |
| Reorder | `PUT /lessons/slides/{slideId}/reorder/{targetSlideId}` | none | Moves `slideId` to just before `targetSlideId`. |
| Delete | `DELETE /lessons/slides/{slideId}` | — | → 204 |

Slide types seen in the picker: `document` (Reading), `quiz`, `code` (Code Challenge), plus survey / pdf / video / webpage / html / sql / rstudio / jupyter / web challenges. New slides are appended (increasing `index`), so create them in the order you want and skip reordering.

### Quiz questions
| Action | Method / path | Body | Notes |
|---|---|---|---|
| Create | `POST /lessons/slides/{slideId}/questions` | JSON — see shape below | → 201 |
| Update | `PUT /lessons/slides/questions/{questionId}` | JSON `{question:{…modified…}}` | → 200. (`PATCH`, and the `/slides/{sid}/questions/{qid}` path, both 404.) |
| Get | `GET /lessons/slides/{slideId}/questions` | — | Returns `{questions:[…]}` (no tokens — safe to read). |

Create body (a **freeform / open-response** question is `data.type: 'general'`, manually graded; `rubric_points` is the max):

```json
{"question":{
  "id":null,"course_id":null,"user_id":null,
  "lesson_slide_id":<slideId>,
  "index":null,"rubric_id":null,"auto_points":null,
  "rubric_points":4,
  "data":{
    "type":"general","formatted":true,"assessed":false,
    "content":"<document version=\"2.0\">…</document>",
    "explanation":"<document version=\"2.0\"><paragraph/></document>"
  }
}}
```

Other question types exist (multiple-choice, true/false, short-answer, numerical, hotspot, parsons) but only `general` was used here.

### Code challenges
| Action | Method / path | Body | Notes |
|---|---|---|---|
| Get | `GET /challenges/{challengeId}` | — | ⚠️ embeds tickets/JWTs — filtered. |
| Configure | `PATCH /challenges/{challengeId}` | JSON `{challenge:{type:'pyunit', content:descXML}}` | → 200 |

- Setting **`type: 'pyunit'`** gives the full PyUnit feature set (run / mark / connect / terminal / editor). No run command is needed — the PyUnit runner auto-discovers `test*.py`.
- `challenge.content` is the **description** shown above the workspace (document XML).
- **Points for an autograded challenge live on the SLIDE, not the challenge:** set `auto_points` on the code slide (via the multipart slide update). `challenge.points` stays 0.
- `settings.per_testcase_scores` toggles all-or-nothing vs per-test scoring.
- `scaffold_hash` / `solution_hash` / `testbase_hash` are content-addressed pointers to the file trees — see the next section; they can't be set to an arbitrary hash.

---

## Content document format

Ed stores rich text as its own XML:

```
<document version="2.0">
  <paragraph>Plain text.</paragraph>
  <pre>def f(x):\n    return x + 1</pre>
</document>
```

- `<paragraph>` for text, `<pre>` for code blocks.
- Escape `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` in both text and code.
- Empty doc: `<document version="2.0"><paragraph/></document>`.

```js
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const doc = parts => '<document version="2.0">' +
  parts.map(x => x.pre !== undefined ? `<pre>${esc(x.pre)}</pre>` : `<paragraph>${esc(x.p)}</paragraph>`).join('') +
  '</document>';
```

---

## Code-challenge files (scaffold / solution / test) — the one thing you can't fully script

The three file trees a code challenge grades against are edited in Ed's **workspace container**, which the browser reaches over a boot-time WebSocket. The workspace ID needed to upload a file is **not** in page state, `localStorage`, the challenge object, or any queryable endpoint — it's only handed to the client over that socket, and only surfaces to plain HTTP the moment an actual upload happens. So there is no way to obtain the ID without an upload, and an upload is exactly what sets the file.

The HTTP upload flow itself (once you somehow hold a live `wid`) is:
1. `POST /workspaces/{wid}/upload` — JSON `{wid, path:'/home/dummy'}` → `{ticket}`
2. `POST https://sahara.us.edstem.org/upload/{ticket}` — multipart, field `file` = the file → returns a file hash
3. Save the challenge — the web client fires `PATCH /challenges/{id}` carrying **tree hashes it computed from the live workspace**. You can't compute those hashes yourself (setting `scaffold_hash` to the upload's file hash 500s).

**Practical consequence:** dropping the scaffold/solution/test files stays a manual step in the Ed UI — drag each file into the Scaffold / Solution / Test tab, then Save. Verify by loading the Solution and clicking Mark. Everything *around* the files (slides, titles, order, questions, description, points, PyUnit config) is scriptable.

---

## Filtered / blocked output

- `GET /lessons/{id}` and `GET /challenges/{id}` responses contain workspace tickets (JWT-like) and query-string-ish blobs. Console/agent output scrubbers may refuse to print them. Work around it by fetching what you need directly — e.g. read quiz questions via `GET /lessons/slides/{sid}/questions` (no tokens) rather than pulling the whole lesson.
- Content that itself contains `key=value`, URLs with query strings, or `?t=…&apikey=…` can also trip an output filter — strip or mask those before printing if you're logging content.

## UI-automation notes (if you drive the picker instead of the API)

- New-slide picker: **Quiz creates on a single click; Code Challenge needs a double-click.** The picker is finicky under automation; the API (multipart create) is far more reliable.
- Slide reordering in the UI is a drag; over the API it's the `…/reorder/…` call above.

---

## End-to-end example: build one HW (code challenge + two quizzes)

```js
const base = "https://us.edstem.org/api";
const TOKEN = "<x-token>";
const JH = {'content-type':'application/json','x-token':TOKEN};
const TH = {'x-token':TOKEN};
const slideForm = o => { const fd = new FormData(); fd.append('slide', JSON.stringify(o)); return fd; };
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const doc = parts => '<document version="2.0">'+parts.map(x=>x.pre!==undefined?`<pre>${esc(x.pre)}</pre>`:`<paragraph>${esc(x.p)}</paragraph>`).join('')+'</document>';

const COURSE = 104656, MODULE = 34165;

// 1. lesson (create ignores title) → then PUT title + module
const {lesson} = await fetch(`${base}/courses/${COURSE}/lessons`, {method:'POST', headers:JH,
  body:JSON.stringify({lesson:{type:'general',kind:'attempt',is_hidden:true}}), credentials:'omit'}).then(r=>r.json());
const L = (await fetch(`${base}/lessons/${lesson.id}`, {headers:TH, credentials:'omit'}).then(r=>r.json())).lesson;
delete L.slides; L.title = 'HW 3'; L.module_id = MODULE;
await fetch(`${base}/lessons/${lesson.id}`, {method:'PUT', headers:JH, body:JSON.stringify({lesson:L}), credentials:'omit'});

// 2. code challenge slide (multipart) → PATCH challenge to pyunit + description → set title + points
const code = (await fetch(`${base}/lessons/${lesson.id}/slides`, {method:'POST', headers:TH,
  body:slideForm({type:'code'}), credentials:'omit'}).then(r=>r.json())).slide;
await new Promise(r=>setTimeout(r,1200)); // challenge init settles
await fetch(`${base}/challenges/${code.challenge_id}`, {method:'PATCH', headers:JH,
  body:JSON.stringify({challenge:{type:'pyunit', content:doc([{p:'Complete the functions in structures.py, then Run and Mark.'}])}}), credentials:'omit'});
const cs = (await fetch(`${base}/lessons/slides/${code.id}`, {headers:TH, credentials:'omit'}).then(r=>r.json())).slide;
delete cs.slides; cs.title = 'Part A - Build and Transform Data'; cs.auto_points = 10;
await fetch(`${base}/lessons/slides/${code.id}`, {method:'PUT', headers:TH, body:slideForm(cs), credentials:'omit'});

// 3. a quiz slide + a freeform question
const quiz = (await fetch(`${base}/lessons/${lesson.id}/slides`, {method:'POST', headers:TH,
  body:slideForm({type:'quiz', is_survey:false}), credentials:'omit'}).then(r=>r.json())).slide;
const qs = (await fetch(`${base}/lessons/slides/${quiz.id}`, {headers:TH, credentials:'omit'}).then(r=>r.json())).slide;
delete qs.slides; qs.title = 'Part B - Choose the Right Structure';
await fetch(`${base}/lessons/slides/${quiz.id}`, {method:'PUT', headers:TH, body:slideForm(qs), credentials:'omit'});
await fetch(`${base}/lessons/slides/${quiz.id}/questions`, {method:'POST', headers:JH,
  body:JSON.stringify({question:{id:null,course_id:null,user_id:null,lesson_slide_id:quiz.id,index:null,rubric_id:null,auto_points:null,
    rubric_points:6, data:{type:'general',formatted:true,assessed:false,
      content:doc([{p:'For each task, name the best built-in structure and give one sentence why. (a) … (b) …'}]),
      explanation:'<document version="2.0"><paragraph/></document>'}}}), credentials:'omit'});

// 4. (manual) drop scaffold/solution/test into the code challenge's tabs, Save, and Mark the Solution to verify.
```

---

## Quick reference

| Task | Call | Body type |
|---|---|---|
| Create module | `POST /courses/{c}/lessons/modules` | JSON `{module:…}` |
| Delete module | `DELETE /lessons/modules/{id}` | — |
| Create lesson | `POST /courses/{c}/lessons` | JSON `{lesson:…}` (title ignored) |
| Rename / move lesson | `PUT /lessons/{id}` | JSON `{lesson:…}` |
| Create slide | `POST /lessons/{l}/slides` | **multipart** `slide=` |
| Edit slide (title/points/order) | `PUT /lessons/slides/{id}` | **multipart** `slide=` |
| Reorder slide | `PUT /lessons/slides/{id}/reorder/{target}` | — |
| Delete slide | `DELETE /lessons/slides/{id}` | — |
| Add quiz question | `POST /lessons/slides/{s}/questions` | JSON `{question:…}` |
| Edit quiz question | `PUT /lessons/slides/questions/{id}` | JSON `{question:…}` |
| Configure code challenge | `PATCH /challenges/{id}` | JSON `{challenge:…}` |
| Upload a workspace file | `POST /workspaces/{wid}/upload` then `POST sahara …/upload/{ticket}` | JSON, then multipart (manual — see above) |
