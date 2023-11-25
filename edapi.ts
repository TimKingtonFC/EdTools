import fetch from "node-fetch";

export interface EdLesson {
  due_at: Date;
  is_timed: boolean;
  password: string;
  release_feedback: boolean;
  release_feedback_while_active: boolean;
  timer_duration: number;
  timer_expiration_access: boolean;
  title: string;

  id: number;
  module_id: string;
  type: string;
  index: string;
  outline: string;
  is_hidden: string;
  is_unlisted: string;
  tutorial_regex: string;
  state: string;
  openable: string;
  release_quiz_solutions: string;
  release_quiz_correctness_only: string;
  release_challenge_solutions: string;
  release_challenge_solutions_while_active: string;
  reopen_submissions: string;
  late_submissions: string;
  available_at: string;
  locked_at: string;
  solutions_at: string;
  settings: string;
  prerequisites: string;

  slides: EdSlide[];
}

export interface EdSlide {
  id: number;
  challenge_id: number;
  title: string;
  type: string;
}

export interface EdSubmission {
  marked_at: string;
}

export interface EdCourse {
  id: number;
  code: string;
  status: string;
  students: Map<string, EdStudent>;
}

export interface EdStudent {
  id: number;
  name: string;
  role: string;
}

export interface EdResult {
  questions: {
    id: number;
    data: {
      content: string;
    };
  }[];
  responses: {
    question_id: number;
    user_id: number;
    user_name: string;
    data: string;
  }[];
}

export interface EdCSVResult {
  NAME: string;
  MARK: number;
}

export async function getEdCourses(token: string): Promise<EdCourse[]> {
  const response = await fetch("https://us.edstem.org/api/user", {
    headers: {
      "x-token": token,
    },
  });
  const data = (await response.json()) as { courses: { course: EdCourse }[] };
  let courses = data.courses.map(({ course }) => course);

  courses = courses.filter(
    (course) => course.status === "active" && !course.code.includes("Master") && course.code !== "Franklin Sandbox"
  );

  for (let course of courses) {
    let students = await getEdStudents(token, course);

    let map = new Map<string, EdStudent>();
    for (let edStudent of students) {
      map.set(edStudent.name, edStudent);
    }
    course.students = map;
  }

  return courses;
}

async function getEdStudents(token: string, course: EdCourse): Promise<EdStudent[]> {
  const response = await fetch(`https://us.edstem.org/api/courses/${course.id}/admin`, {
    headers: {
      "x-token": token,
    },
  });
  const data = (await response.json()) as { users: EdStudent[] };
  return data.users.filter((student) => student.role === "student");
}

export async function getEdLessons(token: string, course: EdCourse): Promise<EdLesson[]> {
  var response = await fetch(`https://us.edstem.org/api/courses/${course.id}/lessons`, {
    headers: {
      "x-token": token,
    },
  });
  const data = (await response.json()) as { lessons: EdLesson[] };
  return data.lessons;
}

export async function getLessonResults(token: string, lesson: EdLesson): Promise<string> {
  var response = await fetch(
    `https://us.edstem.org/api/lessons/${lesson.id}/results.csv?points=0&students=1&completions=0&strategy=latest&tz=America%2FNew_York`,
    {
      method: "POST",
      headers: {
        "x-token": token,
      },
    }
  );
  return response.text();
}

export async function getEdLessonDetails(
  token: string,
  edNameSuffix: string,
  edLessons: EdLesson[]
): Promise<EdLesson> {
  for (const lesson of edLessons) {
    if (lesson.title.endsWith(edNameSuffix)) {
      var response = await fetch(`https://us.edstem.org/api/lessons/${lesson.id}`, {
        headers: {
          "x-token": token,
        },
      });
      const data = (await response.json()) as { lesson: EdLesson };
      return data.lesson;
    }
  }

  throw new Error("Couldn't find lesson:" + edNameSuffix);
}

export async function getEdSubmissions(
  token: string,
  student: EdStudent,
  challenge_id: number
): Promise<EdSubmission[]> {
  var response = await fetch(`https://us.edstem.org/api/users/${student.id}/challenges/${challenge_id}/submissions`, {
    headers: {
      "x-token": token,
    },
  });
  const data = (await response.json()) as { submissions: EdSubmission[] };
  return data.submissions;
}

export async function getEdSlideResults(token: string, slide: EdSlide): Promise<EdResult> {
  var response = await fetch(`https://us.edstem.org/api/lessons/slides/${slide.id}/results`, {
    headers: {
      "x-token": token,
    },
  });
  const data = (await response.json()) as { results: EdResult };
  return data.results;
}
