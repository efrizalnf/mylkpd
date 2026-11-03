<?php
// This file is part of Moodle - https://moodle.org/

namespace mod_mylkpd\form;

defined('MOODLE_INTERNAL') || die();

require_once($CFG->libdir . '/formslib.php');

/**
 * Grade and feedback form for one submission.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class grade_form extends \moodleform {

    /**
     * Form definition.
     */
    protected function definition() {
        $mform = $this->_form;
        $mylkpd = $this->_customdata['mylkpd'];

        $mform->addElement('hidden', 'id');
        $mform->setType('id', PARAM_INT);
        $mform->addElement('hidden', 'userid');
        $mform->setType('userid', PARAM_INT);
        $mform->setDefault('userid', 0);
        $mform->addElement('hidden', 'groupid');
        $mform->setType('groupid', PARAM_INT);
        $mform->setDefault('groupid', 0);

        $gradinginstance = $this->_customdata['gradinginstance'] ?? null;
        if ($gradinginstance) {
            // Rubric or marking guide from Moodle's advanced grading.
            $mform->addElement('grading', 'advancedgrading', get_string('rubricgrade', 'mod_mylkpd'),
                ['gradinginstance' => $gradinginstance]);
            $mform->addElement('hidden', 'advancedgradinginstanceid', $gradinginstance->get_id());
            $mform->setType('advancedgradinginstanceid', PARAM_INT);
        } else if ($mylkpd->grade > 0) {
            $mform->addElement('float', 'grade', get_string('gradeoutof', 'mod_mylkpd', $mylkpd->grade));
        } else if ($mylkpd->grade < 0) {
            $menu = [0 => get_string('nograde')] + make_grades_menu($mylkpd->grade);
            $mform->addElement('select', 'grade', get_string('grade', 'grades'), $menu);
            $mform->setType('grade', PARAM_INT);
        }

        $mform->addElement('textarea', 'feedback', get_string('feedback', 'mod_mylkpd'), ['rows' => 4, 'cols' => 60]);
        $mform->setType('feedback', PARAM_TEXT);

        $mform->addElement('advcheckbox', 'reopen', get_string('reopen', 'mod_mylkpd'));
        $mform->addHelpButton('reopen', 'reopen', 'mod_mylkpd');

        $this->add_action_buttons(true, get_string('savechanges'));
    }

    /**
     * Checks the grade is within range.
     *
     * @param array $data
     * @param array $files
     * @return array
     */
    public function validation($data, $files) {
        $errors = parent::validation($data, $files);
        $mylkpd = $this->_customdata['mylkpd'];
        if (empty($this->_customdata['gradinginstance']) && $mylkpd->grade > 0 && isset($data['grade']) && $data['grade'] !== '' && $data['grade'] !== null) {
            if ($data['grade'] < 0 || $data['grade'] > $mylkpd->grade) {
                $errors['grade'] = get_string('gradeoutofrange', 'mod_mylkpd', $mylkpd->grade);
            }
        }
        return $errors;
    }
}
