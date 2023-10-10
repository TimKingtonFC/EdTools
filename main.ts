import { promises as fs } from "fs";
import fetch from "node-fetch";
import promptSync from "prompt-sync";

const prompt = promptSync(undefined);
let edToken: string;
let dueDates: any; // TODO

async function getCourses(token: string): Promise<EdCourse[]> {
  const response = await fetch("https://us.edstem.org/api/user", {
    headers: {
      "x-token": token,
    },
  });
  const data: any = await response.json();
  return data.courses as EdCourse[];
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

async function updateCourse(course: EdCourse, dueDates: any) {
  // TODO
  var assignments: any; // TODO
  for (const [n, a] of Object.entries(dueDates)) {
    if (course.code.includes(n)) {
      assignments = a;
      break;
    }
  }

  if (!assignments) {
    console.log(`Couldn't find due dates for ${course.code}`);
  }

  const dateStr = prompt("Enter date for HW 1 (m/d): ");
  const [month, day] = dateStr.split("/");
  const hw1DueDate = new Date();
  hw1DueDate.setMonth((month as any) - 1, day as any); // TODO
  hw1DueDate.setHours(23, 59, 0);

  var response = await fetch(
    `https://us.edstem.org/api/courses/${course.id}/lessons`,
    {
      headers: {
        "x-token": edToken,
      },
    }
  );
  const data = (await response.json()) as any; // TODO

  nextAssignment: for (const [name, days] of Object.entries(assignments)) {
    for (const lesson of data.lessons) {
      if (lesson.title.endsWith(name)) {
        const dueDate = new Date(hw1DueDate);
        dueDate.setDate(dueDate.getDate() + (days as number)); // TODO:
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
          (acc, cur) => Object.assign(acc, { [cur]: lesson[cur] }),
          {}
        );

        const body = JSON.stringify({ lesson: filteredLesson });
        console.log(`Setting date for ${lesson.title} to ${dueDate}`);
        response = await fetch(
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
        continue nextAssignment;
      }
    }

    console.log(`Couldn't find lesson for ${name}`);
  }
}

async function loadDueDates() {
  var dueDates: any = {}; // TODO

  const files = await fs.readdir("courses");
  for (const file of files) {
    const courseName = file.slice(0, -5);
    const buf = await fs.readFile(`courses/${file}`);
    dueDates[courseName] = JSON.parse(buf.toString());
  }

  return dueDates;
}

async function loadEdToken() {
  let token: string | undefined = undefined;
  try {
    token = (await fs.readFile(`edtoken.txt`)) as any; // TODO
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

async function useCourse(course: EdCourse) {
  while (true) {
    console.log("1. Grade assignments");
    console.log("2. Set Due Dates");
    console.log("X. Go Back\n");
    let choice = prompt("Your choice? ");

    switch (choice) {
      case "1":
        //gradeAssignments(course);
        break;
      case "2":
        updateCourse(course, dueDates);
        break;
      case "x":
      case "X":
        return;
    }
  }
}

async function main() {
  dueDates = await loadDueDates();
  await loadEdToken();

  var courses: any[] = (await getCourses(edToken)) as any; // TODO
  courses = courses.filter(
    ({ course }) =>
      course.status !== "archived" &&
      !course.code.includes("Master") &&
      course.code !== "Franklin Sandbox"
  );
  courses = courses.map(({ course }) => course);

  while (true) {
    for (const [i, course] of courses.entries()) {
      console.log(i, course.id, course.code);
    }
    var n = prompt("Course to work with?");
    useCourse(courses[n as any]); // TODO
  }
}

main();
