import { promises as fs } from "fs";
import fetch from "node-fetch";
import promptSync from "prompt-sync";

const prompt = promptSync(undefined);

interface CourseSettings {
  assignments: AssignmentSettings[];
}

interface AssignmentSettings {
  name: string;
  dueOffset: number;
}

let edToken: string;

async function getCourses(token: string): Promise<EdCourse[]> {
  const response = await fetch("https://us.edstem.org/api/user", {
    headers: {
      "x-token": token,
    },
  });
  const data = (await response.json()) as { courses: { course: EdCourse }[] };
  let courses = data.courses.map(({ course }) => course);

  courses = courses.filter(
    (course) =>
      course.status !== "archived" &&
      !course.code.includes("Master") &&
      course.code !== "Franklin Sandbox"
  );

  return courses;
}

function makePassword(length: number): string {
  let result = "";
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const charactersLength = characters.length;
  let counter = 0;
  while (counter < length) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
    counter += 1;
  }
  return result;
}

async function fetchLessons(course: EdCourse): Promise<EdLesson[]> {
  var response = await fetch(
    `https://us.edstem.org/api/courses/${course.id}/lessons`,
    {
      headers: {
        "x-token": edToken,
      },
    }
  );
  const data = (await response.json()) as { lessons: EdLesson[] };
  return data.lessons;
}

function getEdLesson(
  name: string,
  edLessons: EdLesson[],
  courseSettings: CourseSettings
): EdLesson {
  for (const { name } of courseSettings.assignments) {
    for (const lesson of edLessons) {
      if (lesson.title.endsWith(name)) {
        return lesson;
      }
    }
  }

  throw new Error("Couldn't find lesson:" + name);
}

async function setupCourse(course: EdCourse, courseSettings: CourseSettings) {
  const dateStr = prompt("Enter date for HW 1 (m/d): ");
  const [month, day] = dateStr.split("/");
  const hw1DueDate = new Date();
  hw1DueDate.setMonth((month as any) - 1, day as any); // TODO
  hw1DueDate.setHours(23, 59, 0);
  const lessons = await fetchLessons(course);

  for (const { name, dueOffset } of courseSettings.assignments) {
    const lesson = getEdLesson(name, lessons, courseSettings);
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
    let response = await fetch(
      `https://us.edstem.org/api/lessons/${lesson.id}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-token": edToken,
        },
        body: body,
      }
    );

    if (!response.ok) {
      console.error("Error setting date", response.statusText);
    }
  }
}

async function gradeAssignments(edCourse: EdCourse) {
  const lessons = await fetchLessons(edCourse);
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

async function loadEdToken() {
  let token: string | undefined = undefined;
  try {
    token = (await fs.readFile(`edtoken.txt`)).toString();
  } catch {}

  while (true) {
    if (token) {
      var courses = await getCourses(token);
      if (courses) {
        await fs.writeFile(`edtoken.txt`, token);
        edToken = token;
        return;
      }
    }

    token = prompt("Enter ed token (x-token header): ");
  }
}

async function useCourse(course: EdCourse, courseSettings: CourseSettings) {
  while (true) {
    console.log("1. Grade assignments");
    console.log("2. Set up course");
    console.log("X. Go Back\n");
    let choice = prompt("Your choice? ");

    try {
      switch (choice) {
        case "1":
          //await gradeAssignments(course);
          break;
        case "2":
          await setupCourse(course, courseSettings);
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

  var courses = await getCourses(edToken);

  while (true) {
    for (const [i, course] of courses.entries()) {
      console.log(i, course.id, course.code);
    }
    var n = Number(prompt("Course to work with?"));
    let edCourse = courses[n];

    let courseSettings: CourseSettings | undefined = undefined;
    for (const [name, cs] of allCourseSettings.entries()) {
      if (edCourse.code.includes(name)) {
        courseSettings = cs;
        break;
      }
    }

    if (!courseSettings) {
      console.log(`Couldn't find due dates for ${edCourse.code}`);
      continue;
    }
    await useCourse(edCourse, courseSettings);
  }
}

main();
