<?php
// This file is part of Moodle - https://moodle.org/

/**
 * Main page: students (alone or as a group) work on the worksheet, teachers preview it.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/locallib.php');
require_once($CFG->libdir . '/completionlib.php');

$id = required_param('id', PARAM_INT);
[$course, $cm] = get_course_and_cm_from_cmid($id, 'mylkpd');
$mylkpd = $DB->get_record('mylkpd', ['id' => $cm->instance], '*', MUST_EXIST);

require_login($course, true, $cm);
$context = context_module::instance($cm->id);
require_capability('mod/mylkpd:view', $context);

$PAGE->set_url('/mod/mylkpd/view.php', ['id' => $cm->id]);
$PAGE->set_title(format_string($mylkpd->name));
$PAGE->set_heading(format_string($course->fullname));

// Only real students fill in the worksheet (admins hold every capability, so exclude doanything).
$cansubmit = has_capability('mod/mylkpd:submit', $context, null, false);
$cangrade = has_capability('mod/mylkpd:grade', $context);
$team = !empty($mylkpd->teamsubmission);
$groupid = ($cansubmit && $team) ? mylkpd_get_user_groupid($cm, $USER->id) : 0;
$nogroup = $cansubmit && $team && !$groupid;

// Final submission. Answers themselves are saved continuously through ajax.php.
if ($cansubmit && !$nogroup && data_submitted() && confirm_sesskey() && optional_param('submitfinal', 0, PARAM_BOOL)) {
    $submission = mylkpd_find_submission($mylkpd, $cm, $USER->id, true);
    if ($submission->status == MYLKPD_STATUS_SUBMITTED) {
        redirect($PAGE->url, get_string('alreadysubmitted', 'mod_mylkpd'), null,
            \core\output\notification::NOTIFY_WARNING);
    }
    $submission->status = MYLKPD_STATUS_SUBMITTED;
    $submission->userid = $USER->id;
    $submission->timemodified = time();
    $DB->update_record('mylkpd_submissions', $submission);
    redirect($PAGE->url, get_string('submitted', 'mod_mylkpd'), null, \core\output\notification::NOTIFY_SUCCESS);
}

$event = \mod_mylkpd\event\course_module_viewed::create(['objectid' => $mylkpd->id, 'context' => $context]);
$event->add_record_snapshot('course', $course);
$event->add_record_snapshot('mylkpd', $mylkpd);
$event->trigger();
(new completion_info($course))->set_module_viewed($cm);

$submission = ($cansubmit && !$nogroup) ? mylkpd_find_submission($mylkpd, $cm, $USER->id) : null;
$issubmitted = $submission && $submission->status == MYLKPD_STATUS_SUBMITTED;
$readonly = !$cansubmit || $nogroup || $issubmitted;
$memberids = $cansubmit ? mylkpd_member_ids($mylkpd, $groupid, $USER->id) : [];
$worksheet = mylkpd_render_worksheet($mylkpd, $cm, $context, $submission, $readonly, $memberids);

echo $OUTPUT->header();

if ($cangrade) {
    $count = $DB->count_records('mylkpd_submissions', ['mylkpdid' => $mylkpd->id, 'status' => MYLKPD_STATUS_SUBMITTED]);
    echo html_writer::div(
        html_writer::link(new moodle_url('/mod/mylkpd/submissions.php', ['id' => $cm->id]),
            get_string('viewsubmissions', 'mod_mylkpd', $count), ['class' => 'btn btn-secondary']),
        'mb-3');
}

if ($nogroup) {
    echo $OUTPUT->notification(get_string('nogroup', 'mod_mylkpd'), \core\output\notification::NOTIFY_WARNING);
} else if ($cansubmit && $team) {
    $members = mylkpd_members($memberids);
    echo html_writer::tag('p', get_string('yourgroup', 'mod_mylkpd', (object) [
        'group' => format_string(groups_get_group_name($groupid)),
        'members' => implode(', ', array_column($members, 'name')),
    ]), ['class' => 'mylkpd-groupinfo']);
}

if ($issubmitted) {
    $key = $team ? 'groupsubmittedinfo' : 'submittedinfo';
    $a = $team ? (object) ['time' => userdate($submission->timemodified),
        'name' => fullname(core_user::get_user($submission->userid))] : userdate($submission->timemodified);
    echo $OUTPUT->notification(get_string($key, 'mod_mylkpd', $a), \core\output\notification::NOTIFY_INFO);
    if ($submission->grade !== null || !empty($submission->feedback)) {
        $out = html_writer::tag('strong', get_string('yourgrade', 'mod_mylkpd') . ': ')
            . s(mylkpd_display_grade($mylkpd, $submission->grade));
        if (!empty($submission->feedback)) {
            $out .= html_writer::div(html_writer::tag('strong', get_string('feedback', 'mod_mylkpd') . ': ')
                . nl2br(s($submission->feedback)), 'mt-2');
        }
        echo $OUTPUT->box($out, 'generalbox mylkpd-result mb-3');
    }
}

if (!$readonly && $worksheet['ready']) {
    echo html_writer::start_tag('form', ['method' => 'post', 'action' => $PAGE->url->out(false), 'id' => 'mylkpd-form']);
    echo html_writer::empty_tag('input', ['type' => 'hidden', 'name' => 'sesskey', 'value' => sesskey()]);
    echo html_writer::empty_tag('input', ['type' => 'hidden', 'name' => 'submitfinal', 'value' => '0',
        'id' => 'mylkpd-submitfinal']);
    echo $worksheet['html'];
    echo html_writer::start_div('mylkpd-actions');
    echo html_writer::span('', 'mylkpd-savestate text-muted small', ['id' => 'mylkpd-savestate', 'aria-live' => 'polite']);
    echo html_writer::tag('button', get_string('savenow', 'mod_mylkpd'),
        ['type' => 'button', 'class' => 'btn btn-secondary', 'data-mylkpd-action' => 'save']);
    echo html_writer::tag('button', get_string('submitfinal', 'mod_mylkpd'),
        ['type' => 'button', 'class' => 'btn btn-primary', 'data-mylkpd-action' => 'submit']);
    echo html_writer::end_div();
    echo html_writer::end_tag('form');
} else {
    echo $worksheet['html'];
}

echo $OUTPUT->footer();
