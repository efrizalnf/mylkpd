<?php
// This file is part of Moodle - https://moodle.org/

/**
 * English strings for mod_mylkpd.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

$string['alreadysubmitted'] = 'This worksheet has already been submitted and can no longer be changed.';
$string['answer'] = 'Answer';
$string['color'] = 'Colour';
$string['colorblack'] = 'Black';
$string['colorblue'] = 'Blue';
$string['colorgreen'] = 'Green';
$string['colorred'] = 'Red';
$string['coloryellow'] = 'Yellow';
$string['confirmsubmit'] = 'Submit your worksheet? You will not be able to change your answers afterwards.';
$string['confirmsubmitgroup'] = 'Submit the worksheet for your whole group? Nobody in the group can change the answers afterwards.';
$string['contribblocks'] = 'Paragraphs';
$string['contribitems'] = 'Answers on the page';
$string['contributions'] = 'Contributions';
$string['contributions_help'] = 'Number of paragraphs and answers that each member changed last.';
$string['editedby'] = 'Last changed by {$a}';
$string['edithint'] = 'Click a paragraph or table cell and type. Your work is saved automatically.';
$string['editing'] = '{$a} is typing';
$string['editneedsdocx'] = '"Edit text" needs a .docx worksheet. Upload a .docx file or choose "Annotate".';
$string['feedback'] = 'Feedback';
$string['formatbold'] = 'Bold';
$string['formatitalic'] = 'Italic';
$string['formatunderline'] = 'Underline';
$string['gradeaction'] = 'View and grade';
$string['gradeoutof'] = 'Grade (out of {$a})';
$string['gradeoutofrange'] = 'Enter a grade between 0 and {$a}.';
$string['gradesaved'] = 'Grade saved.';
$string['gradeuser'] = 'Grade: {$a}';
$string['groupmembers'] = 'Members';
$string['groupsubmittedinfo'] = 'Your group submitted this worksheet on {$a->time} ({$a->name}).';
$string['lastmodified'] = 'Last modified';
$string['loaderror'] = 'The worksheet could not be loaded. Reload the page, or ask your teacher to check the file.';
$string['locktimeout'] = 'The worksheet is busy. Please try again.';
$string['member'] = 'Member';
$string['modulename'] = 'MyLKPD';
$string['modulename_help'] = 'The teacher uploads a worksheet as PDF or Word. Students type their answers directly on the worksheet pages and submit them. The teacher reviews each filled worksheet and gives a grade and feedback.';
$string['modulenameplural'] = 'MyLKPD';
$string['mylkpd:addinstance'] = 'Add a new interactive worksheet';
$string['mylkpd:grade'] = 'Grade interactive worksheets';
$string['mylkpd:submit'] = 'Fill in and submit interactive worksheets';
$string['mylkpd:view'] = 'View interactive worksheets';
$string['nogroup'] = 'This is group work, but you are not in a group yet. Ask your teacher to add you to a group.';
$string['nogroups'] = 'This is group work, but the course has no groups (in the chosen grouping) yet.';
$string['nostudents'] = 'There are no students who can submit this worksheet.';
$string['online'] = 'Online';
$string['pdffailed'] = 'This file could not be displayed. .docx and PDF files always work; .doc and .odt files need a document converter (unoconv or Google Drive) enabled by the site administrator, or save the file again as .docx or PDF.';
$string['pdfnofile'] = 'No worksheet file has been uploaded yet.';
$string['pdfpending'] = 'The worksheet is being prepared. Reload this page in a moment.';
$string['pluginadministration'] = 'MyLKPD administration';
$string['pluginname'] = 'MyLKPD';
$string['privacy:metadata:mylkpd_presence'] = 'Who is currently working on a shared group worksheet.';
$string['privacy:metadata:mylkpd_presence:block'] = 'The paragraph the member is typing in.';
$string['privacy:metadata:mylkpd_presence:timeseen'] = 'When the member was last active.';
$string['privacy:metadata:mylkpd_presence:userid'] = 'The group member.';
$string['privacy:metadata:mylkpd_submissions'] = 'Answers that students write on interactive worksheets.';
$string['privacy:metadata:mylkpd_submissions:answers'] = 'The answers placed on the worksheet pages.';
$string['privacy:metadata:mylkpd_submissions:feedback'] = 'Feedback from the teacher.';
$string['privacy:metadata:mylkpd_submissions:grade'] = 'The grade given by the teacher.';
$string['privacy:metadata:mylkpd_submissions:timemodified'] = 'When the answers were last changed.';
$string['privacy:metadata:mylkpd_submissions:userid'] = 'The student who wrote the answers.';
$string['reopen'] = 'Let the student edit again';
$string['reopen_help'] = 'Returns the submission to draft so the student can revise their answers and submit again.';
$string['saved'] = 'All changes saved';
$string['saveerror'] = 'Could not save. Check your connection; saving will be retried.';
$string['savenow'] = 'Save now';
$string['saving'] = 'Saving…';
$string['settingslocked'] = '"Way of working" and "Group work" can no longer be changed because students have already started.';
$string['statusdraft'] = 'Draft';
$string['statusnotstarted'] = 'Not started';
$string['statussubmitted'] = 'Submitted';
$string['submissions'] = 'Submissions';
$string['submitfinal'] = 'Submit worksheet';
$string['submitted'] = 'Worksheet submitted.';
$string['submittedinfo'] = 'You submitted this worksheet on {$a}.';
$string['teamsubmission'] = 'Group work';
$string['teamsubmission_help'] = 'Each group shares one worksheet. Group members can work at the same time: changes appear for everyone within a few seconds, and a paragraph is locked while a group mate types in it. The grade is given to the whole group.

Uses the course groups. To use only some groups, choose a grouping under "Common module settings". Students who are not in a group cannot work on the worksheet.';
$string['toolbar'] = 'Worksheet tools';
$string['toolcheck'] = 'Tick';
$string['toolcircle'] = 'Circle';
$string['toolcross'] = 'Cross';
$string['toolerase'] = 'Eraser';
$string['toolhighlight'] = 'Highlight';
$string['toolhint'] = 'Choose a tool, then click or drag on the page. Circle, Line and Pen are good for "circle the answer" and "match the pairs".';
$string['toolline'] = 'Line';
$string['toolmove'] = 'Move';
$string['toolpen'] = 'Pen';
$string['tooltext'] = 'Text';
$string['undo'] = 'Undo';
$string['viewsubmissions'] = 'View submissions ({$a} submitted)';
$string['width'] = 'Line thickness';
$string['widthmedium'] = 'Medium';
$string['widththick'] = 'Thick';
$string['widththin'] = 'Thin';
$string['workmode'] = 'Way of working';
$string['workmode_help'] = 'Annotate: students write, tick, circle and draw on top of the worksheet pages (PDF or Word).

Edit text: students type directly into the paragraphs and table cells of the worksheet, like in a word processor. Only for .docx files.';
$string['workmodeannotate'] = 'Annotate (write and draw on the pages)';
$string['workmodeedit'] = 'Edit text (type into the document, .docx only)';
$string['worksheetfile'] = 'Worksheet file';
$string['worksheetfile_help'] = 'Upload one PDF, Word (.docx, .doc) or OpenDocument (.odt) file. PDF and .docx work on every site. If the site has a document converter, Word files are converted to PDF for the most accurate layout; otherwise .docx files are shown directly in the browser. .doc and .odt files need a converter.';
$string['you'] = 'you';
$string['yourgrade'] = 'Your grade';
$string['yourgroup'] = 'Group {$a->group}: {$a->members}';
