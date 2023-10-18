# EdTools

This is a tool to help with using Ed and Canvas.  It lets you quickly set up due dates and move grades from Ed to Canvas.

## Using the Tool

You'll need to install npm, and clone this repository.  Run the tool with `npm start`.
You'll be asked for your Ed and Canvas tokens.  You can get these by using the Chrome 
debugger and looking at the headers for requests as you move around the sites.  You'll be
asked to choose the Ed course and Canvas course you want to use next - make sure you choose
the same course.

Then you have three options:
1. Grade Assignments
2. Get reflection questions
3. Set up course

### Grading Assignments

This is used to copy grades from Ed Assignments to Canvas.  Go to the lesson in Ed and choose "Download Lesson Results...". Save
the resulting csv in your Downloads directory.  Then in EdTools select the assignment and csv file that was downloaded.  It will
assign the grades from Ed to the gradebook in canvas, and for any assignments that were submitted late it will deduct a 10% late
penalty per day, and post a comment in the gradebook stating the late penalty.

### Get reflection questions

I use this to pull questions asked by the students out of the HW reflection question I ask each week.  You select an assignment,
and the questions will be written to `questions.txt`.

### Set up course

This does a few things:
- Assigns due dates to the assignments in the course based on what's in the courses/*.json files.
- If the lesson name contains "Exam", it sets the time limit to 180 minutes and assigns a password so students can't see the assignment early.
- The reveal challenge feedback box on every lesson is checked, so feedback will appear to students immediately as entered.

## Adding a Course

To add a new course, create a new file in the courses directory.  It should have an entry for each assignment you care about.  
It will search for Ed lessons by matching on the suffix and Canvas assignments by matching on the name prefix.  Be careful with
assignments where the name can be the prefix of another assignment - for example if the prefixes are "HW 1" and "HW 10" you won't
get correct behavior.

When setting due dates, you will be asked for the date of the first assignment, and then the dueOffset will be used to set the due
dates for the rest of the assignments.

{
  "assignments": [
    { "edNameSuffix": "HW 1", "dueOffset": 0, "canvasNamePrefix": "Homework 1:" },
    { "edNameSuffix": "HW 2", "dueOffset": 7, "canvasNamePrefix": "Homework 2" },
