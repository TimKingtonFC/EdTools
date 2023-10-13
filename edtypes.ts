interface EdLesson {
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
}

interface EdCourse {
  id: number;
  code: string;
  status: string;
}
