<?php
// This file is part of Moodle - https://moodle.org/

/**
 * Lists all LKPD activities in a course.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require(__DIR__ . '/../../config.php');

$id = required_param('id', PARAM_INT);
$course = $DB->get_record('course', ['id' => $id], '*', MUST_EXIST);
require_course_login($course);

$PAGE->set_url('/mod/mylkpd/index.php', ['id' => $id]);
$PAGE->set_title(get_string('modulenameplural', 'mod_mylkpd'));
$PAGE->set_heading(format_string($course->fullname));
$PAGE->navbar->add(get_string('modulenameplural', 'mod_mylkpd'));

echo $OUTPUT->header();
echo $OUTPUT->heading(get_string('modulenameplural', 'mod_mylkpd'));

$instances = get_all_instances_in_course('mylkpd', $course);
if (!$instances) {
    notice(get_string('thereareno', 'moodle', get_string('modulenameplural', 'mod_mylkpd')),
        new moodle_url('/course/view.php', ['id' => $course->id]));
}

$table = new html_table();
$table->head = [get_string('name')];
foreach ($instances as $instance) {
    $attrs = $instance->visible ? [] : ['class' => 'dimmed'];
    $table->data[] = [html_writer::link(new moodle_url('/mod/mylkpd/view.php', ['id' => $instance->coursemodule]),
        format_string($instance->name), $attrs)];
}
echo html_writer::table($table);
echo $OUTPUT->footer();
