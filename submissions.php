<?php
// This file is part of Moodle - https://moodle.org/

/**
 * Teacher overview of all submissions (per student or per group).
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/locallib.php');

$id = required_param('id', PARAM_INT);
[$course, $cm] = get_course_and_cm_from_cmid($id, 'mylkpd');
$mylkpd = $DB->get_record('mylkpd', ['id' => $cm->instance], '*', MUST_EXIST);

require_login($course, false, $cm);
$context = context_module::instance($cm->id);
require_capability('mod/mylkpd:grade', $context);

$PAGE->set_url('/mod/mylkpd/submissions.php', ['id' => $cm->id]);
$PAGE->set_title(format_string($mylkpd->name) . ': ' . get_string('submissions', 'mod_mylkpd'));
$PAGE->set_heading(format_string($course->fullname));
$PAGE->navbar->add(get_string('submissions', 'mod_mylkpd'));

echo $OUTPUT->header();
echo $OUTPUT->heading(get_string('submissions', 'mod_mylkpd'), 3);

$table = new html_table();
$table->attributes['class'] = 'generaltable table-hover';
$fmt = get_string('strftimedatetimeshort', 'langconfig');

if ($mylkpd->teamsubmission) {
    $groups = groups_get_all_groups($course->id, 0, $cm->groupingid);
    $subs = $DB->get_records_select('mylkpd_submissions', 'mylkpdid = ? AND groupid > 0', [$mylkpd->id]);
    $bygroup = [];
    foreach ($subs as $s) {
        $bygroup[$s->groupid] = $s;
    }
    $table->head = [get_string('group'), get_string('groupmembers', 'mod_mylkpd'), get_string('status'),
        get_string('lastmodified', 'mod_mylkpd'), get_string('grade', 'grades'), ''];
    foreach ($groups as $group) {
        $sub = $bygroup[$group->id] ?? null;
        $members = mylkpd_members(mylkpd_member_ids($mylkpd, $group->id, 0));
        $table->data[] = [
            format_string($group->name),
            s(implode(', ', array_column($members, 'name'))) ?: '-',
            mylkpd_status_badge($sub),
            $sub ? userdate($sub->timemodified, $fmt) : '-',
            s(mylkpd_display_grade($mylkpd, $sub->grade ?? null)),
            html_writer::link(new moodle_url('/mod/mylkpd/grade.php', ['id' => $cm->id, 'groupid' => $group->id]),
                get_string('gradeaction', 'mod_mylkpd'), ['class' => 'btn btn-sm btn-outline-primary']),
        ];
    }
    if (!$groups) {
        echo $OUTPUT->notification(get_string('nogroups', 'mod_mylkpd'), \core\output\notification::NOTIFY_WARNING);
    }
} else {
    groups_print_activity_menu($cm, $PAGE->url);
    $groupid = groups_get_activity_group($cm, true);
    $students = get_enrolled_users($context, 'mod/mylkpd:submit', $groupid, 'u.*', 'u.lastname, u.firstname');
    $subs = $DB->get_records('mylkpd_submissions', ['mylkpdid' => $mylkpd->id, 'groupid' => 0], '',
        'userid, id, status, grade, timemodified');
    $table->head = [get_string('fullname'), get_string('status'), get_string('lastmodified', 'mod_mylkpd'),
        get_string('grade', 'grades'), ''];
    foreach ($students as $student) {
        $sub = $subs[$student->id] ?? null;
        $table->data[] = [
            fullname($student),
            mylkpd_status_badge($sub),
            $sub ? userdate($sub->timemodified, $fmt) : '-',
            s(mylkpd_display_grade($mylkpd, $sub->grade ?? null)),
            html_writer::link(new moodle_url('/mod/mylkpd/grade.php', ['id' => $cm->id, 'userid' => $student->id]),
                get_string('gradeaction', 'mod_mylkpd'), ['class' => 'btn btn-sm btn-outline-primary']),
        ];
    }
    if (!$students) {
        echo $OUTPUT->notification(get_string('nostudents', 'mod_mylkpd'), \core\output\notification::NOTIFY_INFO);
    }
}

if (!empty($table->data)) {
    echo html_writer::table($table);
}
echo $OUTPUT->footer();
