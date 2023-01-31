import fs from "fs/promises";
import fetch from 'node-fetch';
import promptSync from 'prompt-sync';

const prompt = promptSync();

async function getCourses(token) {
    const response = await fetch('https://us.edstem.org/api/user',
      {
        headers: {
            "x-token": token,
        },
      });
    const data = await response.json();
    return data.courses;
}

async function updateCourse(course, dueDates, token) {
  var assignments;
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
  hw1DueDate.setMonth(month - 1, day);
  hw1DueDate.setHours(23, 59, 0);

  var response = await fetch(`https://us.edstem.org/api/courses/${course.id}/lessons`,
    {
      headers: {
          "x-token": token,
      },
    });
  const data = await response.json();

  nextAssignment:
  for (const [name, days] of Object.entries(assignments)) {
    for (const lesson of data.lessons) {
      if (lesson.title.endsWith(name)) {
        const dueDate = new Date(hw1DueDate);
        dueDate.setDate(dueDate.getDate() + days);
        lesson.due_at = dueDate;

        const fields = ["id","module_id","type","title","index","outline","is_hidden","is_unlisted","password","tutorial_regex","is_timed","timer_duration","timer_expiration_access","state","openable","release_quiz_solutions","release_quiz_correctness_only","release_challenge_feedback","release_challenge_solutions","release_challenge_feedback_while_active","release_challenge_solutions_while_active","reopen_submissions","late_submissions","available_at","locked_at","solutions_at","due_at","settings","prerequisites"];
        const filteredLesson = fields.reduce((acc, cur) => Object.assign(acc, { [cur]: lesson[cur] }), {});

        const body = JSON.stringify({lesson: filteredLesson});
        console.log(`Setting date for ${lesson.title} to ${dueDate}`);
        response = await fetch(`https://us.edstem.org/api/lessons/${lesson.id}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-token": token,
          },
          body: body,
        });

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
  var dueDates = {};

  const files = await fs.readdir("courses");
  for (const file of files) {
    const courseName = file.slice(0, -5);
    const buf = await fs.readFile(`courses/${file}`);
    dueDates[courseName] = JSON.parse(buf.toString());
  }

  return dueDates;
}

async function main() {
  var dueDates = await loadDueDates();

  const token = prompt("Enter ed token (x-token header): ");
  var courses = await getCourses(token);
  courses = courses.filter(
    ({course}) => (
      course.status !== "archived" &&
      !course.code.includes("Master") &&
      course.code !== "Franklin Sandbox"));
  courses = courses.map(({course}) => course);

  for (const [i, course] of courses.entries()) {
    console.log(i, course.id, course.code);
  }

  var n = prompt('Course to update?');

  updateCourse(courses[n], dueDates, token);
}

main();

export default {getCourses};
