/* site.js — Apps by Dan
   Two small jobs: the mobile nav toggle and the footer year. The site is fully
   readable with JavaScript off; this only adds convenience. */
(function () {
    'use strict';

    var toggle = document.querySelector('.nav-toggle');
    var nav = document.getElementById('site-nav');

    if (toggle && nav) {
        toggle.addEventListener('click', function () {
            var open = nav.classList.toggle('is-open');
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        // Close the menu on Escape so keyboard users aren't trapped in it.
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && nav.classList.contains('is-open')) {
                nav.classList.remove('is-open');
                toggle.setAttribute('aria-expanded', 'false');
                toggle.focus();
            }
        });
    }

    var year = document.getElementById('year');
    if (year) { year.textContent = new Date().getFullYear(); }
}());
