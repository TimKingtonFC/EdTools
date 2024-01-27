import fetch, { RequestInfo, RequestInit, Response } from "node-fetch";

// TODO: Wrap with module CanvasAPI, remove stuttering
export interface CanvasCourse {
  id: number;
  name: string;
  end_at: string;
  students: Map<string, CanvasStudent>;
}

export interface CanvasAssignment {
  id: number;
  name: string;
  submissions: Map<number, CanvasSubmission>;
}

export interface CanvasStudent {
  id: number;
  name: string;
}

export interface CanvasSubmission {
  id: number;
  user_id: number;
}

async function canvasFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  let resp = await fetch(input, init);
  // let cost = resp.headers.get("x-request-cost");
  // let remaining = resp.headers.get("x-rate-limit-remaining");
  // console.log(input, cost, remaining);

  return resp;
}

export async function getCanvasCourses(token: string): Promise<CanvasCourse[]> {
  const response = await canvasFetch("https://franklin.instructure.com/api/v1/courses?per_page=100", {
    headers: {
      Authorization: token,
    },
  });
  let courses = (await response.json()) as CanvasCourse[];
  let oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  courses = courses.filter((course) => new Date(course.end_at) >= oneWeekAgo);

  for (let course of courses) {
    let students = await getCanvasStudents(token, course);

    let map = new Map<string, CanvasStudent>();
    for (let edStudent of students) {
      map.set(edStudent.name, edStudent);
    }
    course.students = map;
  }
  // TODO: Get assignments here?

  return courses;
}

// TODO: Get rid of canvas lots of places
export async function getCanvasAssignments(canvasToken: string, course: CanvasCourse): Promise<CanvasAssignment[]> {
  const response = await canvasFetch(
    `https://franklin.instructure.com/api/v1/courses/${course.id}/assignments?per_page=50`,
    {
      headers: {
        Authorization: canvasToken,
      },
    }
  );
  let assignments = (await response.json()) as CanvasAssignment[];

  // TODO: Remove
  // TODO: Reduce requests
  // for (let assignment of assignments) {
  //   assignment.submissions = await getCanvasSubmissions(canvasToken, course, assignment);
  // }

  return assignments;
}
// TODO: Remove?
export async function getCanvasSubmissions(
  canvasToken: string,
  course: CanvasCourse,
  assignment: CanvasAssignment
): Promise<Map<number, CanvasSubmission>> {
  const response = await canvasFetch(
    `https://franklin.instructure.com/api/v1/courses/${course.id}/assignments/${assignment.id}/submissions`,
    {
      headers: {
        Authorization: canvasToken,
      },
    }
  );

  let subs = new Map<number, CanvasSubmission>();
  for (let sub of (await response.json()) as CanvasSubmission[]) {
    subs.set(sub.user_id, sub);
  }
  return subs;
}

async function getCanvasStudents(canvasToken: string, course: CanvasCourse): Promise<CanvasStudent[]> {
  const response = await canvasFetch(
    `https://franklin.instructure.com/api/v1/courses/${course.id}/users?enrollment_type=student&per_page=50`,
    {
      headers: {
        Authorization: canvasToken,
      },
    }
  );
  return (await response.json()) as CanvasStudent[];
}

export async function assignCanvasGrade(
  canvasToken: string,
  course: CanvasCourse,
  assignment: CanvasAssignment,
  student: CanvasStudent,
  grade: number,
  comment: string,
  daysLate: number
): Promise<void> {
  let body: any = {
    submission: {
      assignment_id: assignment.id,
      user_id: student.id,
      posted_grade: grade,
    },
    include: ["visibility"],
    prefer_points_over_scheme: true,
  };

  if (comment && comment.length > 0) {
    body.comment = {
      group_comment: 0,
      text_comment: comment,
    };
  }

  if (daysLate > 0) {
    body.submission.late_policy_status = "late";
    body.submission.seconds_late_override = daysLate * 24 * 60 * 60;
  }

  const response = await canvasFetch(
    `https://franklin.instructure.com/api/v1/courses/${course.id}/assignments/${assignment.id}/submissions/${student.id}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Authorization: canvasToken,
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    console.error("Error setting grade", response.statusText);
  }
}
