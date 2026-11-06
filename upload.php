<?php
// This file is part of Moodle - https://moodle.org/

/**
 * Receives an image a student adds to the worksheet and stores it with their (or their group's) submission.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

define('AJAX_SCRIPT', true);

require(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/locallib.php');

$cmid = required_param('cmid', PARAM_INT);
[$course, $cm] = get_course_and_cm_from_cmid($cmid, 'mylkpd');
require_login($course, false, $cm, false, true);
require_sesskey();

$context = context_module::instance($cm->id);
if (!has_capability('mod/mylkpd:submit', $context, null, false)) {
    throw new required_capability_exception($context, 'mod/mylkpd:submit', 'nopermissions', '');
}
$mylkpd = $DB->get_record('mylkpd', ['id' => $cm->instance], '*', MUST_EXIST);

echo json_encode(mylkpd_store_answer_image($mylkpd, $cm, $context, (int) $USER->id, $_FILES['image'] ?? null));
