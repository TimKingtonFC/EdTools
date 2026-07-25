import Anthropic from "@anthropic-ai/sdk";
import { parse } from "csv-parse/sync";
import { promises as fs } from "fs";
import { encode } from "html-entities";
import fetch from "node-fetch";
import OpenAI from "openai";
import promptSync from "prompt-sync";
import {
  CanvasAssignment,
  CanvasCourse,
  assignCanvasGrade,
  getCanvasAssignments,
  getCanvasCourses,
  isAssignmentGraded,
  setCanvasSession,
} from "./canvasapi.js";
import { ensureCanvasSession } from "./canvasAuth.js";
import {
  EdCSVResult,
  EdCourse,
  EdLesson,
  createThreadDraft,
  getEdCourses,
  getEdLessonDetails,
  getLessonResults as getEdLessonResults,
  getEdLessons,
  getEdSlideResults,
  getEdSubmissions,
  getEdToken,
  listDiscussionPosts,
  listThreadDrafts,
  postThread,
} from "./edapi.js";

const prompt = promptSync({ sigint: true });

const GRADING_DROP_DEAD_DAYS = 3;

interface CourseSettings {
  assignments: AssignmentSettings[];
}

interface AssignmentSettings {
  name: string;
  edNameSuffix: string;
  dueOffset: number;
  canvasNamePrefix?: string;
  canvasNameExact?: string;
  videos?: [VideoLink];
  restrictSubmissions: boolean;
}

interface VideoLink {
  name: string;
  link: string;
}

let edToken: string;
let openAIKey: string;
let anthropicKey: string;

const QA_ANSWER_PROMPT_HEADER = `You are answering weekly student Q&A posts as the course instructor. The
instructor is a software engineer with ~30 years of professional experience
(and 40+ coding for fun). Match his voice and follow the processing rules below.

## Voice and style
- Concise and direct. Usually 1–5 sentences. No filler, no throat-clearing,
  no restating the question back.
- Blunt and opinionated. It's fine to say something is dumb, pointless, or
  something "you'd never actually do."
- Grounded in real-world practice. Favor "in practice you'd just use the
  library / the built-in" over textbook theory. Cite concrete specifics when
  useful (e.g., Java uses red-black trees for TreeMap; HashMap resizes at 0.75;
  PriorityQueue is a heap; Timsort/dual-pivot quicksort).
- Honest about limits. If the answer is "no," "never," "no idea," or "that's
  too big to cover here," just say so.
- Reassuring to struggling students, without sugar-coating the difficulty.
- Dry humor is welcome but optional. Don't force it.
- Personal questions (day at work, advice, hobbies, opinions) get short,
  candid, human answers.

## Input handling (the input is noisy — clean it up)
1. Fix obvious OCR/transcription noise, garbled words, and typos in the
   questions. Rewrite badly mangled questions into clear ones while preserving
   the intent.
2. Ignore extraction artifacts like "Here are the questions (exact wording):",
   leading numbers/word counts, and similar metadata.
3. "<Name>'s reflection is too short: ..." notice — the reflection prose is
   padding; DROP it. But the student's actual question appears as the next
   item — KEEP and answer that question.
4. "<Name>'s reflection has no questions" / "<Name> asked no questions" notice —
   there is nothing to answer. Ignore the notice AND the post following it
   entirely.
5. Treat "implied question" markers and vague "I'm still confused about X"
   statements as a request to explain X, and answer them.

## Grouping
- Combine questions ONLY when they ask almost exactly the same thing (even if
  from different students). List all the combined questions in bold, then give
  one answer.
- When several questions clearly come from one student, decide per-batch:
  combine them if they're the same/closely related topic; answer separately if
  they cover meaningfully different topics.
- Don't over-group. When in doubt, keep questions separate. Related-but-distinct
  questions each get their own answer.

## Output format
- For each question (or combined group), put the question(s) in **bold** first,
  then the answer below in plain text.
- Answer in the instructor's voice as described above.
- Present answers in a sensible reading order (grouped clusters together).

Here are sample past answers to calibrate the voice:`;

function makePassword(length: number): string {
  let result = "";
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const charactersLength = characters.length;
  let counter = 0;
  while (counter < length) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
    counter += 1;
  }
  return result;
}

async function postVideos(course: EdCourse, dropDeadDate: Date, videos: [VideoLink]) {
  for (const vidlink of videos) {
    console.log(`Posting video link: ${vidlink.name}`);
    let body = `<paragraph>${encode(vidlink.name)}:</paragraph><paragraph>${encode(vidlink.link)}</paragraph>`;
    await postThread(edToken, course, vidlink.name, body, dropDeadDate);
  }
}

async function getReflectionAnswers() {
  for (var course of await getEdCourses(edToken, false, (c) => true)) {
    var courseNum: string;
    if (course.code.includes("311")) {
      courseNum = "311";
    } else if (course.code.includes("611")) {
      courseNum = "611";
    } else continue;

    let threads = await listDiscussionPosts(edToken, course);
    for (let thread of threads) {
      if (thread.user.name !== "Tim Kington" || !thread.title.startsWith("HW") || !thread.title.endsWith("Questions")) {
        continue;
      }

      let week = parseInt(thread.title.substring(2, thread.title.length - 10));
      if (isNaN(week)) {
        console.log("Skipping " + thread.title);
        continue;
      }

      await fs.mkdir(`questions/${courseNum}/${week}`, { recursive: true });
      await fs.writeFile(
        `questions/${courseNum}/${week}/${course.year}-${course.session}-${thread.id}.txt`,
        thread.document,
      );
    }
  }
}

async function setupCourse(course: EdCourse, courseSettings: CourseSettings) {
  const dateStr = prompt("Enter date for HW 1 (m/d): ");
  const [month, day] = dateStr.split("/");
  const hw1DueDate = new Date();
  hw1DueDate.setMonth((month as any) - 1, day as any); // TODO
  hw1DueDate.setHours(23, 59, 0);

  const dropDeadStr = prompt("Enter drop dead offset [3,18:30]: ", "3,18:30");
  const [dropDeadDays, dropDeadTime] = dropDeadStr.split(",");
  const [dropDeadHours, dropDeadMinutes] = dropDeadTime.split(":");

  const lessons = await getEdLessons(edToken, course);

  for (const { edNameSuffix, dueOffset, videos, restrictSubmissions } of courseSettings.assignments) {
    let lesson: EdLesson;
    try {
      lesson = await getEdLessonDetails(edToken, edNameSuffix, lessons);
    } catch {
      console.log("Couldn't find lesson:" + edNameSuffix);
      continue;
    }
    const dueDate = new Date(hw1DueDate);
    dueDate.setDate(dueDate.getDate() + dueOffset);
    lesson.due_at = dueDate;
    lesson.release_feedback = true;
    lesson.release_feedback_while_active = true;

    if (lesson.title.startsWith("Exercises")) {
      lesson.release_challenge_solutions_while_active = true;
    }

    if (lesson.title.includes("Exam")) {
      lesson.is_timed = true;
      lesson.timer_duration = 180;
      lesson.timer_expiration_access = false;
      lesson.password = makePassword(8);
    }

    const fields = [
      "id",
      "module_id",
      "type",
      "title",
      "index",
      "outline",
      "is_hidden",
      "is_unlisted",
      "password",
      "tutorial_regex",
      "is_timed",
      "timer_duration",
      "timer_expiration_access",
      "state",
      "openable",
      "release_quiz_solutions",
      "release_quiz_correctness_only",
      "release_feedback",
      "release_challenge_solutions",
      "release_feedback_while_active",
      "release_challenge_solutions_while_active",
      "reopen_submissions",
      "late_submissions",
      "available_at",
      "locked_at",
      "solutions_at",
      "due_at",
      "settings",
      "prerequisites",
    ];

    const filteredLesson = fields.reduce(
      (acc, cur) => Object.assign(acc, { [cur]: (lesson as any)[cur] }), // TODO - find better way?  Test which fields need to be there?
      {},
    );

    let body = { lesson: filteredLesson } as any;

    if (restrictSubmissions) {
      body.lesson.require_user_override = true;
      body.override_upserts = [];
      for (var student of course.students.values()) {
        body.override_upserts.push({ lesson_id: lesson.id, user_id: student.id });
      }
    }

    const bodyJSON = JSON.stringify(body);

    console.log(`Setting date for ${lesson.title} to ${dueDate}`);
    let response = await fetch(`https://us.edstem.org/api/lessons/${lesson.id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-token": edToken,
      },
      body: bodyJSON,
    });

    if (!response.ok) {
      console.error("Error setting date", response.statusText);
    }

    if (videos) {
      const dropDeadDate = new Date(dueDate);
      dropDeadDate.setDate(dropDeadDate.getDate() + parseInt(dropDeadDays));
      dropDeadDate.setHours(parseInt(dropDeadHours), parseInt(dropDeadMinutes), 0);
      await postVideos(course, dropDeadDate, videos);
    }
  }
}

async function revealExerciseSolutions(course: EdCourse) {
  const lessons = await getEdLessons(edToken, course);
  for (const lesson of lessons) {
    if (!lesson.title.startsWith("Exercises")) continue;

    console.log(`Revealing challenge solutions for ${lesson.title}`);
    const response = await fetch(`https://us.edstem.org/api/lessons/${lesson.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-token": edToken },
      body: JSON.stringify({ lesson: { ...lesson, release_challenge_solutions_while_active: true } }),
    });

    if (!response.ok) {
      console.error(`Error revealing solutions for ${lesson.title}`, response.statusText);
    }
  }
}

function chooseAssignment(courseSettings: CourseSettings): AssignmentSettings {
  for (const [i, assignment] of courseSettings.assignments.entries()) {
    console.log(i, assignment.edNameSuffix);
  }
  var n = Number(prompt("Assignment to grade?"));
  return courseSettings.assignments[n];
}

async function extractQuestionsForAssignment(
  assignmentSettings: AssignmentSettings,
  edLessons: EdLesson[],
): Promise<string> {
  let edLesson = await getEdLessonDetails(edToken, assignmentSettings.edNameSuffix, edLessons);
  let slide = edLesson.slides.find((s) => s.title === "Quiz" && s.type == "quiz");
  if (!slide) {
    throw new Error("Couldn't find slide");
  }

  let results = await getEdSlideResults(edToken, slide);
  let question = results.questions.find((q) => q.data.content.includes("two to three paragraphs"));
  if (!question) {
    throw new Error("Couldn't find question");
  }

  let qid = question.id;
  let answers = results.responses.filter((r) => r.question_id === qid);

  const openai = new OpenAI({
    apiKey: openAIKey,
  });

  let studentQuestions = "";
  for (let answer of answers) {
    console.log(`Processing reflection for ${answer.user_name}`);

    let chatCompletion = await openai.chat.completions.create({
      messages: [
        {
          role: "user",
          content:
            `Please find any questions in the following text and list them with their exact wording.  Include implied questions containing phrases like "I'm still wondering about" or "I would like to know" or "I'm not sure about". If there are no questions, please tell me \"${answer.user_name} asked no questions\".  Here is the text: ` +
            answer.data,
        },
      ],
      model: "gpt-5-nano",
    });

    let response: string | undefined | null = chatCompletion.choices[0].message.content;
    console.log(response);
    if (
      response?.includes("asked no questions") ||
      response?.includes("does not contain any questions") ||
      response?.includes("no explicit questions")
    ) {
      console.log("No questions found");
      studentQuestions += ` ${answer.user_name}'s reflection has no questions: ` + answer.data + " ";
    }

    let wc = answer.data.split(" ").length;
    if (wc < 120) {
      console.log("The reflection is too short:", wc);
      studentQuestions += ` ${answer.user_name}'s reflection is too short: ` + wc + " " + answer.data + " ";
    }
    studentQuestions += response + " ";
  }

  return studentQuestions;
}

async function getQuestions(courseSettings: CourseSettings, edCourse: EdCourse): Promise<void> {
  let assignmentSettings = chooseAssignment(courseSettings);
  let edLessons = await getEdLessons(edToken, edCourse);
  let studentQuestions = await extractQuestionsForAssignment(assignmentSettings, edLessons);
  await fs.writeFile("questions.txt", studentQuestions);
}

function findCanvasAssignment(
  canvasAssignments: CanvasAssignment[],
  assignmentSettings: AssignmentSettings,
): CanvasAssignment | undefined {
  for (let ass of canvasAssignments) {
    if (assignmentSettings.canvasNameExact === ass.name) {
      return ass;
    }
    if (assignmentSettings.canvasNamePrefix && ass.name.startsWith(assignmentSettings.canvasNamePrefix)) {
      return ass;
    }
  }
  return undefined;
}

async function gradeAssignments(courseSettings: CourseSettings, edCourse: EdCourse, canvasCourse: CanvasCourse) {
  let assignmentSettings = chooseAssignment(courseSettings);
  let canvasAssignments = await getCanvasAssignments(canvasCourse);
  let canvasAssignment = findCanvasAssignment(canvasAssignments, assignmentSettings);
  if (!canvasAssignment) {
    throw new Error("Couldn't find canvas assignment for " + assignmentSettings.edNameSuffix);
  }

  let edLessons = await getEdLessons(edToken, edCourse);
  await gradeOneAssignment(edCourse, canvasCourse, canvasAssignment, assignmentSettings, edLessons);
}

async function gradeOneAssignment(
  edCourse: EdCourse,
  canvasCourse: CanvasCourse,
  canvasAssignment: CanvasAssignment,
  assignmentSettings: AssignmentSettings,
  edLessons: EdLesson[],
): Promise<void> {
  let edLesson = await getEdLessonDetails(edToken, assignmentSettings.edNameSuffix, edLessons);

  console.log("Getting lesson results...");
  let resultsCSV = await getEdLessonResults(edToken, edLesson);

  // Discard first row - useless headers.
  let csvLines = resultsCSV.split(/\r\n|\r|\n/);
  csvLines = csvLines.slice(1);

  const data = parse(csvLines.join("\n"), {
    columns: true,
    skip_empty_lines: true,
  }) as EdCSVResult[];

  for (let r of data) {
    let canvasStudent = canvasCourse.students.get(r.NAME);
    let edStudent = edCourse.students.get(r.NAME);
    if (!canvasStudent || !edStudent) {
      console.log("Couldn't find student", r.NAME);
      continue;
    }

    let lessonDaysLate = 0;
    for (let slide of edLesson.slides) {
      let submissions = await getEdSubmissions(edToken, edStudent, slide.challenge_id);
      if (!submissions || submissions.length < 1) {
        continue;
      }

      let daysLate = Math.ceil(
        (+new Date(submissions[0].marked_at) - +new Date(edLesson.due_at)) / (24 * 60 * 60 * 1000),
      );
      lessonDaysLate = Math.max(lessonDaysLate, daysLate);
    }

    let comment = "";
    let penalty = 0;
    if (lessonDaysLate > 0) {
      if (lessonDaysLate > 3) {
        penalty = r.MARK;
      } else {
        penalty = Math.round(r.MARK * 0.1 * lessonDaysLate);
      }
      if (penalty > 0) {
        comment = `${r.MARK} - ${penalty} (late)`;
      }
    }
    let grade = r.MARK - penalty;
    console.log(`Assigning grade of ${grade} to ${r.NAME}`, comment);
    await assignCanvasGrade(canvasCourse, canvasAssignment, canvasStudent, grade, comment, lessonDaysLate);
  }
}

async function loadCourseSettings(): Promise<Map<string, CourseSettings>> {
  var dueDates = new Map<string, CourseSettings>();

  const files = await fs.readdir("courses");
  for (const file of files) {
    const courseName = file.slice(0, -5);
    const buf = await fs.readFile(`courses/${file}`);
    dueDates.set(courseName, JSON.parse(buf.toString()));
  }

  return dueDates;
}

function checkRoster(edCourse: EdCourse, canvasCourse: CanvasCourse): void {
  let missingStudents = [];
  for (let canvasStudent of canvasCourse.students.values()) {
    let es = edCourse.students.get(canvasStudent.name);
    if (!es) {
      missingStudents.push(canvasStudent.name);
    }
  }
  if (missingStudents.length > 0) {
    throw new Error("Couldn't find ed students for " + missingStudents);
  }
}

function findCourseSettings(
  allCourseSettings: Map<string, CourseSettings>,
  edCourse: EdCourse,
): CourseSettings | undefined {
  for (const [name, cs] of allCourseSettings.entries()) {
    if (edCourse.code.includes(name)) {
      return cs;
    }
  }
  return undefined;
}

async function useCourse(courseSettings: CourseSettings, edCourse: EdCourse, canvasCourse: CanvasCourse) {
  checkRoster(edCourse, canvasCourse);

  while (true) {
    console.log("1. Grade assignments");
    console.log("2. Get reflection questions");
    console.log("R. Reveal exercise solutions");
    console.log("S. Set up course");
    console.log("X. Go Back\n");
    let choice = prompt("Your choice? ");

    try {
      switch (choice) {
        case "1":
          await gradeAssignments(courseSettings, edCourse, canvasCourse);
          break;
        case "2":
          await getQuestions(courseSettings, edCourse);
          break;
        case "r":
        case "R":
          await revealExerciseSolutions(edCourse);
          break;
        case "s":
        case "S":
          await setupCourse(edCourse, courseSettings);
          break;
        case "x":
        case "X":
          return;
      }
    } catch (ex) {
      console.log(ex);
    }
  }
}

async function loadCourseMapping(): Promise<any> {
  try {
    return JSON.parse((await fs.readFile("course-mapping.json")).toString());
  } catch {
    return {};
  }
}

function isHwAssignment(assignmentSettings: AssignmentSettings): boolean {
  return /^HW \d+$/.test(assignmentSettings.edNameSuffix);
}

function confirm(message: string): boolean {
  return prompt(`${message} Proceed? [y/N] `)?.toLowerCase() === "y";
}

async function autoGradeAssignment(
  edCourse: EdCourse,
  canvasCourse: CanvasCourse,
  assignmentSettings: AssignmentSettings,
  edLessons: EdLesson[],
): Promise<void> {
  let canvasAssignments = await getCanvasAssignments(canvasCourse);
  let canvasAssignment = findCanvasAssignment(canvasAssignments, assignmentSettings);
  if (!canvasAssignment) {
    console.log(`${edCourse.code}: couldn't find canvas assignment for ${assignmentSettings.edNameSuffix}, skipping`);
    return;
  }

  if (await isAssignmentGraded(canvasCourse, canvasAssignment)) {
    console.log(`${edCourse.code} ${assignmentSettings.edNameSuffix}: already graded, skipping`);
    return;
  }

  if (!confirm(`Grade ${edCourse.code} ${assignmentSettings.edNameSuffix} (Canvas: ${canvasAssignment.name}).`)) {
    console.log("Skipped");
    return;
  }

  await gradeOneAssignment(edCourse, canvasCourse, canvasAssignment, assignmentSettings, edLessons);
}

function courseNumFor(edCourse: EdCourse): string | undefined {
  if (edCourse.code.includes("311")) return "311";
  if (edCourse.code.includes("611")) return "611";
  return undefined;
}

async function loadHistoricalQA(courseNum: string, hwNumber: string): Promise<string> {
  const dir = `questions/${courseNum}/${hwNumber}`;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return "";
  }

  let samples = "";
  for (const file of files) {
    if (!file.endsWith(".txt")) continue;
    samples += (await fs.readFile(`${dir}/${file}`, "utf8")) + "\n\n";
  }
  return samples;
}

async function generateAnswers(
  edCourse: EdCourse,
  assignmentSettings: AssignmentSettings,
  rawQuestions: string,
): Promise<string> {
  const courseNum = courseNumFor(edCourse);
  const hwMatch = assignmentSettings.edNameSuffix.match(/^HW (\d+)$/);
  const hwNumber = hwMatch?.[1];

  const samples = courseNum && hwNumber ? await loadHistoricalQA(courseNum, hwNumber) : "";

  const prompt =
    `${QA_ANSWER_PROMPT_HEADER}\n\n${samples || "(No past answers on file for this assignment.)"}` +
    `\n\n---\n\nNow here are this week's raw extracted student reflections to process. Apply the rules ` +
    `above (clean up noise, drop padding for short reflections, ignore no-question notices) and produce ` +
    `your answer document for these new questions only — do not repeat or re-answer the calibration ` +
    `examples above:\n\n${rawQuestions}`;

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const message = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  return textBlock?.type === "text" ? textBlock.text : "";
}

function markdownToEdDocument(markdown: string): string {
  const paragraphs = markdown.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  return paragraphs
    .map((paragraph) => {
      const inner = paragraph
        .split(/(\*\*[^*]+\*\*)/g)
        .map((part) => {
          const boldMatch = part.match(/^\*\*([^*]+)\*\*$/);
          return boldMatch ? `<bold>${encode(boldMatch[1])}</bold>` : encode(part);
        })
        .join("");
      return `<paragraph>${inner}</paragraph>`;
    })
    .join("");
}

async function autoPostQuestions(
  edCourse: EdCourse,
  assignmentSettings: AssignmentSettings,
  edLessons: EdLesson[],
): Promise<void> {
  const title = `${assignmentSettings.edNameSuffix} Questions`;

  const drafts = await listThreadDrafts(edToken, edCourse);
  if (drafts.some((d) => d.title === title)) {
    console.log(`${edCourse.code}: draft "${title}" already exists, skipping`);
    return;
  }

  const posts = await listDiscussionPosts(edToken, edCourse);
  if (posts.some((p) => p.title === title)) {
    console.log(`${edCourse.code}: "${title}" already posted, skipping`);
    return;
  }

  if (!confirm(`Post "${title}" draft thread for ${edCourse.code}.`)) {
    console.log("Skipped");
    return;
  }

  const rawQuestions = await extractQuestionsForAssignment(assignmentSettings, edLessons);
  console.log("Generating draft answers with Claude...");
  const answers = await generateAnswers(edCourse, assignmentSettings, rawQuestions);
  const body = markdownToEdDocument(answers);
  await createThreadDraft(edToken, edCourse, title, body);
}

async function autoSweepCourse(
  courseSettings: CourseSettings,
  edCourse: EdCourse,
  canvasCourse: CanvasCourse,
): Promise<void> {
  checkRoster(edCourse, canvasCourse);

  let edLessons = await getEdLessons(edToken, edCourse);
  let now = new Date();

  for (let assignmentSettings of courseSettings.assignments) {
    try {
      let edLesson: EdLesson;
      try {
        edLesson = await getEdLessonDetails(edToken, assignmentSettings.edNameSuffix, edLessons);
      } catch {
        console.log(`${edCourse.code}: couldn't find lesson ${assignmentSettings.edNameSuffix}, skipping`);
        continue;
      }

      if (!edLesson.due_at) {
        console.log(`${edCourse.code} ${assignmentSettings.edNameSuffix}: no due date set, skipping`);
        continue;
      }

      let dropDead = new Date(edLesson.due_at);
      dropDead.setDate(dropDead.getDate() + GRADING_DROP_DEAD_DAYS);
      if (now < dropDead) {
        continue;
      }

      await autoGradeAssignment(edCourse, canvasCourse, assignmentSettings, edLessons);

      if (isHwAssignment(assignmentSettings)) {
        await autoPostQuestions(edCourse, assignmentSettings, edLessons);
      }
    } catch (ex) {
      console.log(`${edCourse.code} ${assignmentSettings.edNameSuffix}: error`, ex);
    }
  }
}

async function autoSweep(
  allCourseSettings: Map<string, CourseSettings>,
  edCourses: EdCourse[],
  canvasCourses: CanvasCourse[],
  courseMapping: any,
): Promise<void> {
  for (let edCourse of edCourses) {
    if (courseMapping[edCourse.code]) continue;

    console.log(`No Canvas mapping for ${edCourse.code}.`);
    for (const [i, course] of canvasCourses.entries()) {
      console.log(i, course.name);
    }
    let n = Number(prompt(`Canvas course for ${edCourse.code}? `));
    let canvasCourse = canvasCourses[n];
    courseMapping[edCourse.code] = canvasCourse.name;
    await fs.writeFile("course-mapping.json", JSON.stringify(courseMapping));
  }

  for (let edCourse of edCourses) {
    let courseSettings = findCourseSettings(allCourseSettings, edCourse);
    if (!courseSettings) {
      console.log(`Couldn't find settings for ${edCourse.code}, skipping auto-sweep`);
      continue;
    }

    let canvasCourseName = courseMapping[edCourse.code];
    let canvasCourse = canvasCourses.find((c) => c.name === canvasCourseName);
    if (!canvasCourse) {
      console.log(`Couldn't find canvas course "${canvasCourseName}" for ${edCourse.code}, skipping`);
      continue;
    }

    console.log(`\nAuto-sweeping ${edCourse.code}...`);
    try {
      await autoSweepCourse(courseSettings, edCourse, canvasCourse);
    } catch (ex) {
      console.log(`${edCourse.code}: error during auto-sweep`, ex);
    }
  }
}

async function main() {
  let allCourseSettings = await loadCourseSettings();
  let secrets = JSON.parse((await fs.readFile("secrets.json")).toString());
  edToken = await getEdToken(secrets["ed-user"], secrets["ed-password"]);
  setCanvasSession(await ensureCanvasSession());
  openAIKey = secrets["openai-key"];
  anthropicKey = secrets["anthropic-key"];

  var edCourses = await getEdCourses(
    edToken,
    true,
    (course: EdCourse) =>
      !!(
        course.status === "active" &&
        !course.code.includes("Master") &&
        course.code !== "Franklin Sandbox" &&
        allCourseSettings.get(course.code)
      ),
  );

  console.log("loading canvas courses");
  var canvasCourses = await getCanvasCourses();
  console.log("loading canvas courses done");
  var courseMapping = await loadCourseMapping();

  await autoSweep(allCourseSettings, edCourses, canvasCourses, courseMapping);

  while (true) {
    for (const [i, course] of edCourses.entries()) {
      console.log(i, course.id, course.code);
    }
    console.log("G. Get reflection answers");
    var entry = prompt("Course to work with?");
    if (entry === "g" || entry === "G") {
      await getReflectionAnswers();
      continue;
    }
    var n = Number(entry);
    let edCourse = edCourses[n];

    let canvasCourseName = courseMapping[edCourse.code];
    let canvasCourse: CanvasCourse | undefined;
    if (canvasCourseName) {
      canvasCourse = canvasCourses.find((c) => c.name == canvasCourseName);
    }

    if (!canvasCourse) {
      for (const [i, course] of canvasCourses.entries()) {
        console.log(i, course.name);
      }
      var n = Number(prompt("Course to work with?"));
      canvasCourse = canvasCourses[n];

      courseMapping[edCourse.code] = canvasCourse.name;
      await fs.writeFile("course-mapping.json", JSON.stringify(courseMapping));
    }

    let courseSettings = findCourseSettings(allCourseSettings, edCourse);

    if (!courseSettings) {
      console.log(`Couldn't find settings for ${edCourse.code}`);
      continue;
    }
    await useCourse(courseSettings, edCourse, canvasCourse);
  }
}

main();
