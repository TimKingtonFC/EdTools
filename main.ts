import { parse } from "csv-parse/sync";
import { promises as fs } from "fs";
import fetch from "node-fetch";
import { homedir } from "os";
import { join } from "path";
import promptSync from "prompt-sync";
import { CanvasCourse, assignCanvasGrade, getCanvasAssignments, getCanvasCourses } from "./canvasapi.js";
import {
  EdCSVResult,
  EdCourse,
  getEdCourses,
  getEdLessonDetails,
  getEdLessons,
  getEdSlideResults,
  getEdSubmissions,
} from "./edapi.js";

const prompt = promptSync(undefined);

interface CourseSettings {
  assignments: AssignmentSettings[];
}

interface AssignmentSettings {
  edNameSuffix: string;
  dueOffset: number;
  canvasNamePrefix: string;
}

let edToken: string;
let canvasToken: string;

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

async function setupCourse(course: EdCourse, courseSettings: CourseSettings) {
  const dateStr = prompt("Enter date for HW 1 (m/d): ");
  const [month, day] = dateStr.split("/");
  const hw1DueDate = new Date();
  hw1DueDate.setMonth((month as any) - 1, day as any); // TODO
  hw1DueDate.setHours(23, 59, 0);
  const lessons = await getEdLessons(edToken, course);

  for (const { edNameSuffix, dueOffset } of courseSettings.assignments) {
    const lesson = await getEdLessonDetails(edToken, edNameSuffix, lessons);
    const dueDate = new Date(hw1DueDate);
    dueDate.setDate(dueDate.getDate() + dueOffset);
    lesson.due_at = dueDate;
    lesson.release_feedback = true;
    lesson.release_feedback_while_active = true;

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
      {}
    );

    const body = JSON.stringify({ lesson: filteredLesson });
    console.log(`Setting date for ${lesson.title} to ${dueDate}`);
    let response = await fetch(`https://us.edstem.org/api/lessons/${lesson.id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-token": edToken,
      },
      body: body,
    });

    if (!response.ok) {
      console.error("Error setting date", response.statusText);
    }
  }
}

function chooseAssignment(courseSettings: CourseSettings): AssignmentSettings {
  for (const [i, assignment] of courseSettings.assignments.entries()) {
    console.log(i, assignment.canvasNamePrefix);
  }
  var n = Number(prompt("Assignment to grade?"));
  return courseSettings.assignments[n];
}

async function getQuestions(courseSettings: CourseSettings, edCourse: EdCourse) {
  let assignmentSettings = chooseAssignment(courseSettings);

  let edLessons = await getEdLessons(edToken, edCourse);
  let edLesson = await getEdLessonDetails(edToken, assignmentSettings.edNameSuffix, edLessons);
  let slide = edLesson.slides.find((s) => s.title === "Quiz" && s.type == "quiz");
  if (!slide) {
    console.log("Couldn't find slide");
    return;
  }

  let results = await getEdSlideResults(edToken, slide);
  let question = results.questions.find((q) => q.data.content.includes("two to three paragraphs"));
  if (!question) {
    console.log("Couldn't find question");
    return;
  }

  let qid = question.id;
  let answers = results.responses.filter((r) => r.question_id === qid);
  for (let a of answers) {
    console.log(`${a.user_id}:${a.data}`);
  }
}

async function gradeAssignments(courseSettings: CourseSettings, edCourse: EdCourse, canvasCourse: CanvasCourse) {
  let assignmentSettings = chooseAssignment(courseSettings);
  let canvasAssignments = await getCanvasAssignments(canvasToken, canvasCourse);
  let canvasAssignment;
  for (let ass of canvasAssignments) {
    if (ass.name.startsWith(assignmentSettings.canvasNamePrefix)) {
      canvasAssignment = ass;
    }
  }
  if (!canvasAssignment) {
    throw new Error("Couldn't find canvas assignment for " + assignmentSettings);
  }

  // TODO: Fetch lessons once.  Rework this?
  // TODO: Break up long functions
  let edLessons = await getEdLessons(edToken, edCourse);
  let edLesson = await getEdLessonDetails(edToken, assignmentSettings.edNameSuffix, edLessons);

  const downloadDir = join(homedir(), "Downloads");
  const filenames = (await fs.readdir(downloadDir)).filter(
    (name) => name.endsWith(".csv") && name.indexOf("results") >= 0
  );

  for (const [i, filename] of filenames.entries()) {
    console.log(i, filename);
  }
  var n = Number(prompt("Results file?"));
  let filename = join(downloadDir, filenames[n]);

  // Discard first row - useless headers.
  let csvLines = (await fs.readFile(filename)).toString().split(/\r\n|\r|\n/);
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
        (+new Date(submissions[0].marked_at) - +new Date(edLesson.due_at)) / (24 * 60 * 60 * 1000)
      );
      lessonDaysLate = Math.max(lessonDaysLate, daysLate);
    }

    let comment = "";
    let penalty = 0;
    if (lessonDaysLate > 0) {
      if (lessonDaysLate > 3) {
        penalty = r.MARK;
      } else {
        penalty = Math.ceil(r.MARK * 0.1 * lessonDaysLate);
      }
      if (penalty > 0) {
        comment = `${r.MARK} - ${penalty} (late)`;
      }
    }
    console.log(`Assigning grade of ${r.MARK} to ${r.NAME}`, comment);
    await assignCanvasGrade(
      canvasToken,
      canvasCourse,
      canvasAssignment,
      canvasStudent,
      r.MARK - penalty,
      comment,
      lessonDaysLate
    );
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

async function loadToken(
  tokenFilename: string,
  tokenPrompt: string,
  verificationFn: (token: string) => any
): Promise<string> {
  let token: string | undefined = undefined;
  try {
    token = (await fs.readFile(tokenFilename)).toString();
  } catch {}

  while (true) {
    if (token) {
      if (await verificationFn(token)) {
        await fs.writeFile(tokenFilename, token);
        return token;
      }
    }

    token = prompt(tokenPrompt);
  }
}

async function loadEdToken() {
  edToken = await loadToken("edtoken.txt", "Enter ed token (x-token header): ", (token: string) => getEdCourses(token));
}

async function loadCanvasToken() {
  canvasToken = await loadToken("canvastoken.txt", "Enter canvas token (Authorization header): ", (token: string) =>
    getCanvasCourses(token)
  );
}

async function useCourse(courseSettings: CourseSettings, edCourse: EdCourse, canvasCourse: CanvasCourse) {
  for (let canvasStudent of canvasCourse.students.values()) {
    let es = edCourse.students.get(canvasStudent.name);
    if (!es) {
      throw new Error("Couldn't find ed student for " + canvasStudent.name);
    }
  }

  while (true) {
    console.log("1. Grade assignments");
    console.log("2. Get reflection questions");
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

async function main() {
  let allCourseSettings = await loadCourseSettings();
  await loadEdToken();
  await loadCanvasToken();

  var edCourses = await getEdCourses(edToken);
  var canvasCourses = await getCanvasCourses(canvasToken);

  while (true) {
    for (const [i, course] of edCourses.entries()) {
      console.log(i, course.id, course.code);
    }
    var n = Number(prompt("Course to work with?"));
    let edCourse = edCourses[n];

    // TODO: Auto-map courses?  Remember mapping?
    for (const [i, course] of canvasCourses.entries()) {
      console.log(i, course.name);
    }
    var n = Number(prompt("Course to work with?"));
    let canvasCourse = canvasCourses[n];

    let courseSettings: CourseSettings | undefined = undefined;
    for (const [name, cs] of allCourseSettings.entries()) {
      if (edCourse.code.includes(name)) {
        courseSettings = cs;
        break;
      }
    }

    if (!courseSettings) {
      console.log(`Couldn't find settings for ${edCourse.code}`);
      continue;
    }
    await useCourse(courseSettings, edCourse, canvasCourse);
  }
}

main();
