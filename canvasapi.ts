import fetch, { RequestInfo, RequestInit, Response } from "node-fetch";
import { CanvasSession } from "./canvasAuth.js";

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
  workflow_state: string;
  graded_at: string | null;
}

// Auth for every Canvas request. Set once at startup via setCanvasSession().
let session: CanvasSession | undefined;

export function setCanvasSession(newSession: CanvasSession): void {
  session = newSession;
}

async function canvasFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  if (!session) {
    throw new Error("Canvas session not set - call setCanvasSession() before making requests.");
  }

  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {}),
    Cookie: session.cookie,
  };

  // Canvas requires a CSRF token on anything that changes state.
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers["X-CSRF-Token"] = session.csrfToken;
  }

  return await fetch(input, { ...init, headers });
}

// Parses a JSON response, turning an auth/API failure into a clear error instead
// of a cryptic "x.filter is not a function" downstream.
async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Canvas ${what} request failed (${response.status}): ${body}`);
  }
  return (await response.json()) as T;
}

export async function getCanvasCourses(): Promise<CanvasCourse[]> {
  const response = await canvasFetch("https://franklin.instructure.com/api/v1/courses?per_page=500");
  let courses = await readJson<CanvasCourse[]>(response, "courses");
  let oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  courses = courses.filter((course) => new Date(course.end_at) >= oneWeekAgo);

  for (let course of courses) {
    let students = await getCanvasStudents(course);

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
export async function getCanvasAssignments(course: CanvasCourse): Promise<CanvasAssignment[]> {
  const response = await canvasFetch(
    `https://franklin.instructure.com/api/v1/courses/${course.id}/assignments?per_page=50`
  );
  return await readJson<CanvasAssignment[]>(response, "assignments");
}
// TODO: Remove?
export async function getCanvasSubmissions(
  course: CanvasCourse,
  assignment: CanvasAssignment
): Promise<Map<number, CanvasSubmission>> {
  const response = await canvasFetch(
    `https://franklin.instructure.com/api/v1/courses/${course.id}/assignments/${assignment.id}/submissions`
  );

  let subs = new Map<number, CanvasSubmission>();
  for (let sub of await readJson<CanvasSubmission[]>(response, "submissions")) {
    subs.set(sub.user_id, sub);
  }
  return subs;
}

export async function isAssignmentGraded(
  course: CanvasCourse,
  assignment: CanvasAssignment
): Promise<boolean> {
  const submissions = await getCanvasSubmissions(course, assignment);
  for (let submission of submissions.values()) {
    if (submission.workflow_state === "graded") {
      return true;
    }
  }
  return false;
}

async function getCanvasStudents(course: CanvasCourse): Promise<CanvasStudent[]> {
  const response = await canvasFetch(
    `https://franklin.instructure.com/api/v1/courses/${course.id}/users?enrollment_type=student&per_page=50`
  );
  return await readJson<CanvasStudent[]>(response, "students");
}

export async function assignCanvasGrade(
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
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errBody = await response.text();
    console.error("Error setting grade", response.status, errBody);
  }
}
