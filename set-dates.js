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
  // TODO: test expired token
  // TODO: Get token from user

  var dueDates = await loadDueDates();

  // const r = await fetch("https://us.edstem.org/api/lessons/53148", {
  //   "headers": {
  //     "accept": "*/*",
  //     "accept-language": "en-US,en;q=0.9",
  //     "content-type": "application/json",
  //     "sec-ch-ua": "\"Not_A Brand\";v=\"99\", \"Google Chrome\";v=\"109\", \"Chromium\";v=\"109\"",
  //     "sec-ch-ua-mobile": "?0",
  //     "sec-ch-ua-platform": "\"macOS\"",
  //     "sec-fetch-dest": "empty",
  //     "sec-fetch-mode": "cors",
  //     "sec-fetch-site": "same-site",
  //     "x-token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXBlIjoidG9rZW4iLCJ1c2VyX2lkIjoyMDkwMzQsInNlc3Npb25faWQiOjY1MzMyNTAzLCJyZWdpb24iOiIiLCJpYXQiOjE2NzUxNzU0NjUsImV4cCI6MTY3NjM4NTA2NX0.5uq4S8SPmxUCjWu9GlcvVSVTlxB5Vre9GC_tewLVOH8"
  //   },
  //   "referrerPolicy": "same-origin",
  //   "body": "{\"lesson\":{\"id\":53148,\"module_id\":12071,\"type\":\"java\",\"title\":\"Comp 311 HW 1\",\"index\":1,\"outline\":\"\",\"is_hidden\":false,\"is_unlisted\":false,\"password\":\"\",\"tutorial_regex\":\"\",\"is_timed\":false,\"timer_duration\":60,\"timer_expiration_access\":false,\"state\":\"active\",\"openable\":false,\"release_quiz_solutions\":false,\"release_quiz_correctness_only\":false,\"release_challenge_feedback\":false,\"release_challenge_solutions\":false,\"release_challenge_feedback_while_active\":false,\"release_challenge_solutions_while_active\":false,\"reopen_submissions\":false,\"late_submissions\":true,\"available_at\":null,\"locked_at\":null,\"solutions_at\":null,\"due_at\":\"2023-02-02T04:57:00.000Z\",\"settings\":{\"quiz_question_number_style\":\"\",\"quiz_mode\":\"hide-solution-until-correct\",\"quiz_active_status\":\"active\"},\"prerequisites\":[]}}",
  //   "method": "PUT",
  //   "mode": "cors",
  //   "credentials": "omit"
  // });

  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXBlIjoidG9rZW4iLCJ1c2VyX2lkIjoyMDkwMzQsInNlc3Npb25faWQiOjY1MzMyNTAzLCJyZWdpb24iOiIiLCJpYXQiOjE2NzUxNzU0NjUsImV4cCI6MTY3NjM4NTA2NX0.5uq4S8SPmxUCjWu9GlcvVSVTlxB5Vre9GC_tewLVOH8";
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
