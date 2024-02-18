import { parse } from "csv-parse/sync";
import { promises as fs } from "fs";
import fetch from "node-fetch";
import OpenAI from "openai";
import promptSync from "prompt-sync";
import { CanvasCourse, assignCanvasGrade, getCanvasAssignments, getCanvasCourses } from "./canvasapi.js";
import {
  EdCSVResult,
  EdCourse,
  EdLesson,
  getEdCourses,
  getEdLessonDetails,
  getLessonResults as getEdLessonResults,
  getEdLessons,
  getEdSlideResults,
  getEdSubmissions,
  getEdToken,
} from "./edapi.js";

const prompt = promptSync({ sigint: true });

interface CourseSettings {
  assignments: AssignmentSettings[];
}

interface AssignmentSettings {
  edNameSuffix: string;
  dueOffset: number;
  canvasNamePrefix?: string;
  canvasNameExact?: string;
}

let edToken: string;
let canvasToken: string;
let openAIKey: string;

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
    let lesson: EdLesson;
    try {
      lesson = await getEdLessonDetails(edToken, edNameSuffix, lessons);
    }
    catch {
      console.log("Couldn't find lesson:" + edNameSuffix);
      continue;
    }
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

async function getQuestions(courseSettings: CourseSettings, edCourse: EdCourse): Promise<void> {
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
          content: "Please find any questions in the following text and list them.  Here is the text: " + answer.data,
        },
      ],
      model: "gpt-4",
    });

    let response: string | undefined | null = chatCompletion.choices[0].message.content;
    console.log(response);
    if (response?.includes("does not contain any questions")) {
      console.log("No questions found");
      studentQuestions += ` ${answer.user_name}'s reflection has no questions: ` + answer.data + " ";
    }

    let wc = answer.data.split(" ").length;
    if (wc < 120) {
      console.log("The reflection is too short:", wc);
      studentQuestions += ` ${answer.user_name}'s reflection is too short: ` + wc + " " + answer.data + " ";
    }
    studentQuestions += response + " ";
    await fs.writeFile("questions.txt", studentQuestions);
  }
}

async function gradeAssignments(courseSettings: CourseSettings, edCourse: EdCourse, canvasCourse: CanvasCourse) {
  let assignmentSettings = chooseAssignment(courseSettings);
  let canvasAssignments = await getCanvasAssignments(canvasToken, canvasCourse);
  let canvasAssignment;
  for (let ass of canvasAssignments) {
    if (assignmentSettings.canvasNameExact === ass.name) {
      canvasAssignment = ass;
      break;
    }
    if (assignmentSettings.canvasNamePrefix && ass.name.startsWith(assignmentSettings.canvasNamePrefix)) {
      canvasAssignment = ass;
      break;
    }
  }
  if (!canvasAssignment) {
    throw new Error("Couldn't find canvas assignment for " + assignmentSettings);
  }

  // TODO: Fetch lessons once.  Rework this?
  // TODO: Break up long functions
  let edLessons = await getEdLessons(edToken, edCourse);
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
        penalty = Math.round(r.MARK * 0.1 * lessonDaysLate);
      }
      if (penalty > 0) {
        comment = `${r.MARK} - ${penalty} (late)`;
      }
    }
    let grade = r.MARK - penalty;
    console.log(`Assigning grade of ${grade} to ${r.NAME}`, comment);
    await assignCanvasGrade(canvasToken, canvasCourse, canvasAssignment, canvasStudent, grade, comment, lessonDaysLate);
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

async function loadCourseMapping(): Promise<any> {
  try {
    return JSON.parse((await fs.readFile("course-mapping.json")).toString());
  }
  catch {
    return {};
  }
}

async function main() {
  let allCourseSettings = await loadCourseSettings();
  let secrets = JSON.parse((await fs.readFile("secrets.json")).toString());
  edToken = await getEdToken(secrets["ed-user"], secrets["ed-password"]);
  canvasToken = secrets["canvas-token"];
  openAIKey = secrets["openai-key"];

  var edCourses = await getEdCourses(edToken);
  console.log("loading canvas courses");
  var canvasCourses = await getCanvasCourses(canvasToken);
  console.log("loading canvas courses done");
  var courseMapping = await loadCourseMapping();

  while (true) {
    for (const [i, course] of edCourses.entries()) {
      console.log(i, course.id, course.code);
    }
    var n = Number(prompt("Course to work with?"));
    let edCourse = edCourses[n];

    let canvasCourseName = courseMapping[edCourse.code];
    let canvasCourse: CanvasCourse | undefined;
    if (canvasCourseName) {
      canvasCourse = canvasCourses.find(c => c.name == canvasCourseName);
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
