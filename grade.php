<?php
// This file is part of Moodle - https://moodle.org/

/**
 * Teacher views one filled worksheet (a student's or a group's) and grades it.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/locallib.php');

$id = required_param('id', PARAM_INT);
$userid = optional_param('userid', 0, PARAM_INT);
$groupid = optional_param('groupid', 0, PARAM_INT);
[$course, $cm] = get_course_and_cm_from_cmid($id, 'mylkpd');
$mylkpd = $DB->get_record('mylkpd', ['id' => $cm->instance], '*', MUST_EXIST);

require_login($course, false, $cm);
$context = context_module::instance($cm->id);
require_capability('mod/mylkpd:grade', $context);

$team = !empty($mylkpd->teamsubmission);
if ($team) {
    $group = groups_get_group($groupid, '*', MUST_EXIST);
    if ($group->courseid != $course->id) {
        throw new moodle_exception('invalidgroupid');
    }
    $title = format_string($group->name);
    $params = ['mylkpdid' => $mylkpd->id, 'groupid' => $groupid];
    $urlparams = ['id' => $cm->id, 'groupid' => $groupid];
} else {
    $user = core_user::get_user($userid, '*', MUST_EXIST);
    if (!is_enrolled($context, $user, 'mod/mylkpd:submit')) {
        throw new moodle_exception('nostudents', 'mod_mylkpd');
    }
    $title = fullname($user);
    $params = ['mylkpdid' => $mylkpd->id, 'userid' => $userid, 'groupid' => 0];
    $urlparams = ['id' => $cm->id, 'userid' => $userid];
}
$submission = $DB->get_record('mylkpd_submissions', $params);
$memberids = mylkpd_member_ids($mylkpd, $groupid, $userid);

$PAGE->set_url('/mod/mylkpd/grade.php', $urlparams);
$PAGE->set_title(format_string($mylkpd->name) . ': ' . $title);
$PAGE->set_heading(format_string($course->fullname));
$returnurl = new moodle_url('/mod/mylkpd/submissions.php', ['id' => $cm->id]);
$PAGE->navbar->add(get_string('submissions', 'mod_mylkpd'), $returnurl);
$PAGE->navbar->add($title);

$form = new \mod_mylkpd\form\grade_form($PAGE->url, ['mylkpd' => $mylkpd]);
$form->set_data($urlparams + [
    'grade' => $submission->grade ?? null,
    'feedback' => $submission->feedback ?? '',
]);

if ($form->is_cancelled()) {
    redirect($returnurl);
}

if ($data = $form->get_data()) {
    $grade = null;
    if ($mylkpd->grade > 0 && isset($data->grade) && $data->grade !== '') {
        $grade = (float) $data->grade;
    } else if ($mylkpd->grade < 0 && !empty($data->grade)) {
        $grade = (int) $data->grade;
    }
    $now = time();
    if (!$submission) {
        $submission = (object) ($params + [
            'userid' => $userid,
            'answers' => '{"items":{},"blocks":{}}',
            'status' => MYLKPD_STATUS_DRAFT,
            'revision' => 0,
            'timecreated' => $now,
            'timemodified' => $now,
        ]);
        $submission->id = $DB->insert_record('mylkpd_submissions', $submission);
    }
    $submission->grade = $grade;
    $submission->feedback = $data->feedback;
    $submission->timegraded = $now;
    if (!empty($data->reopen)) {
        $submission->status = MYLKPD_STATUS_DRAFT;
    }
    $DB->update_record('mylkpd_submissions', $submission);
    mylkpd_update_grades($mylkpd);

    redirect($returnurl, get_string('gradesaved', 'mod_mylkpd'), null, \core\output\notification::NOTIFY_SUCCESS);
}

$worksheet = mylkpd_render_worksheet($mylkpd, $cm, $context, $submission ?: null, true, $memberids);

echo $OUTPUT->header();
echo $OUTPUT->heading(get_string('gradeuser', 'mod_mylkpd', $title), 3);

if (!$submission) {
    echo $OUTPUT->notification(get_string('statusnotstarted', 'mod_mylkpd'), \core\output\notification::NOTIFY_INFO);
} else {
    $key = $submission->status == MYLKPD_STATUS_SUBMITTED ? 'statussubmitted' : 'statusdraft';
    echo html_writer::tag('p', get_string($key, 'mod_mylkpd') . ' (' . userdate($submission->timemodified) . ')');
}

if ($team) {
    // Who changed what, so the teacher can see each member's share of the group work.
    $members = mylkpd_members($memberids);
    $contrib = mylkpd_contributions(mylkpd_decode_data($submission->answers ?? null));
    $table = new html_table();
    $table->head = [get_string('member', 'mod_mylkpd'), get_string('contribblocks', 'mod_mylkpd'),
        get_string('contribitems', 'mod_mylkpd')];
    $table->attributes['class'] = 'generaltable mylkpd-contrib';
    foreach ($members as $uid => $m) {
        $table->data[] = [
            html_writer::span('', 'mylkpd-dot', ['style' => 'background:' . $m['color']]) . ' ' . s($m['name']),
            $contrib[$uid]['blocks'] ?? 0,
            $contrib[$uid]['items'] ?? 0,
        ];
    }
    echo $OUTPUT->heading(get_string('contributions', 'mod_mylkpd'), 4);
    echo html_writer::tag('p', get_string('contributions_help', 'mod_mylkpd'), ['class' => 'text-muted small']);
    echo html_writer::table($table);
}

echo $worksheet['html'];
echo $OUTPUT->box_start('generalbox mylkpd-gradebox');
$form->display();
echo $OUTPUT->box_end();
echo $OUTPUT->footer();
