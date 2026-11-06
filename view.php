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
    mylkpd_cleanup_images($context, $submission);
    redirect($PAGE->url, get_string('submitted', 'mod_mylkpd'), null, \core\output\notification::NOTIFY_SUCCESS);
}

// Edit again: put a submitted worksheet back to draft so it can be changed and submitted again.
if ($cansubmit && !$nogroup && data_submitted() && confirm_sesskey() && optional_param('reopen', 0, PARAM_BOOL)) {
    $submission = mylkpd_find_submission($mylkpd, $cm, $USER->id);
    if (!mylkpd_can_reopen($mylkpd, $submission)) {
        redirect($PAGE->url, get_string('cannotreopen', 'mod_mylkpd'), null, \core\output\notification::NOTIFY_WARNING);
    }
    $submission->status = MYLKPD_STATUS_DRAFT;
    $submission->timemodified = time();
    $DB->update_record('mylkpd_submissions', $submission);
    redirect($PAGE->url, get_string('reopened', 'mod_mylkpd'), null, \core\output\notification::NOTIFY_SUCCESS);
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
}

// Status card: where the student stands, the grade, feedback and the filled-in rubric.
if ($cansubmit && !$nogroup) {
    if ($issubmitted) {
        $badge = html_writer::span(get_string('statussubmitted', 'mod_mylkpd'), 'badge bg-success badge-success');
        $a = (object) ['time' => userdate($submission->timemodified),
            'name' => fullname(core_user::get_user($submission->userid))];
        $info = get_string($team ? 'groupsubmittedinfo' : 'submittedinfo', 'mod_mylkpd', $team ? $a : $a->time);
    } else {
        $badge = html_writer::span(get_string($submission ? 'statusdraft' : 'statusnotstarted', 'mod_mylkpd'),
            'badge bg-warning text-dark badge-warning');
        $info = get_string('draftinfo', 'mod_mylkpd');
    }
    $card = html_writer::div($badge . html_writer::span($info, 'mylkpd-status-text'), 'mylkpd-status-line');
    if ($team) {
        $members = mylkpd_members($memberids);
        $card .= html_writer::div(get_string('yourgroup', 'mod_mylkpd', (object) [
            'group' => format_string(groups_get_group_name($groupid)),
            'members' => implode(', ', array_column($members, 'name')),
        ]), 'mylkpd-groupinfo small text-muted');
    }
    if ($submission && ($submission->grade !== null || !empty($submission->feedback))) {
        $card .= html_writer::div(html_writer::tag('strong', get_string('yourgrade', 'mod_mylkpd') . ': ') .
            s(mylkpd_display_grade($mylkpd, $submission->grade)), 'mylkpd-grade');
        if (!empty($submission->feedback)) {
            $card .= html_writer::div(html_writer::tag('strong', get_string('feedback', 'mod_mylkpd') . ': ') .
                nl2br(s($submission->feedback)), 'mylkpd-feedback');
        }
        // Show the rubric with the levels the teacher chose.
        if ($submission->grade !== null && ($controller = mylkpd_grading_controller($mylkpd, $context))) {
            try {
                require_once($CFG->libdir . '/gradelib.php');
                $gradeinfo = grade_get_grades($course->id, 'mod', 'mylkpd', $mylkpd->id, $USER->id);
                $gradeitem = $gradeinfo->items[0] ?? null;
                if ($gradeitem && $controller->is_form_available()) {
                    $card .= html_writer::div($controller->render_grade($PAGE, $submission->id, $gradeitem, '', false),
                        'mylkpd-rubricresult');
                }
            } catch (\Throwable $e) {
                debugging('MyLKPD rubric display: ' . $e->getMessage(), DEBUG_DEVELOPER);
            }
        }
    }
    echo html_writer::div($card, 'mylkpd-statuscard');
}

$canreopen = $issubmitted && mylkpd_can_reopen($mylkpd, $submission);

if (!$readonly && $worksheet['ready']) {
    echo html_writer::start_tag('form', ['method' => 'post', 'action' => $PAGE->url->out(false), 'id' => 'mylkpd-form']);
    echo html_writer::empty_tag('input', ['type' => 'hidden', 'name' => 'sesskey', 'value' => sesskey()]);
    echo html_writer::empty_tag('input', ['type' => 'hidden', 'name' => 'submitfinal', 'value' => '0',
        'id' => 'mylkpd-submitfinal']);
    echo $worksheet['html'];
    echo html_writer::start_div('mylkpd-actions');
    echo html_writer::span('', 'mylkpd-savestate small', ['id' => 'mylkpd-savestate', 'role' => 'status',
        'aria-live' => 'polite']);
    echo html_writer::tag('button', '&#128190; ' . get_string('savenow', 'mod_mylkpd'),
        ['type' => 'button', 'class' => 'btn btn-secondary', 'data-mylkpd-action' => 'save']);
    echo html_writer::tag('button', '&#10148; ' . get_string('submitfinal', 'mod_mylkpd'),
        ['type' => 'button', 'class' => 'btn btn-primary', 'data-mylkpd-action' => 'submit']);
    echo html_writer::end_div();
    echo html_writer::end_tag('form');
} else {
    echo $worksheet['html'];
    if ($issubmitted) {
        // Same place as the submit button: the bottom action bar.
        echo html_writer::start_tag('form', ['method' => 'post', 'action' => $PAGE->url->out(false),
            'class' => 'mylkpd-actions mylkpd-reopen',
            'data-mylkpd-confirm' => get_string($team ? 'editagainconfirmgroup' : 'editagainconfirm', 'mod_mylkpd')]);
        echo html_writer::empty_tag('input', ['type' => 'hidden', 'name' => 'sesskey', 'value' => sesskey()]);
        echo html_writer::empty_tag('input', ['type' => 'hidden', 'name' => 'reopen', 'value' => 1]);
        if ($canreopen) {
            echo html_writer::span(get_string('editagainhint', 'mod_mylkpd'), 'mylkpd-savestate small text-muted');
            echo html_writer::tag('button', '&#9998; ' . get_string('editagain', 'mod_mylkpd'),
                ['type' => 'submit', 'class' => 'btn btn-primary']);
        } else {
            $reason = ((int) ($mylkpd->allowresubmit ?? 1) === 0) ? 'cannotreopensetting' : 'cannotreopengraded';
            echo html_writer::span(get_string($reason, 'mod_mylkpd'), 'mylkpd-savestate small text-muted');
            echo html_writer::tag('button', '&#128274; ' . get_string('editagain', 'mod_mylkpd'),
                ['type' => 'button', 'class' => 'btn btn-outline-secondary', 'disabled' => 'disabled']);
        }
        echo html_writer::end_tag('form');
        if ($canreopen) {
            $PAGE->requires->js_init_code("document.querySelectorAll('form[data-mylkpd-confirm]').forEach(function(f) {
                f.addEventListener('submit', function(e) {
                    if (!window.confirm(f.getAttribute('data-mylkpd-confirm'))) { e.preventDefault(); }
                });
            });", true);
        }
    }
}

echo $OUTPUT->footer();
